# Progress reporting for Bash scripts. Source this file, then call:
#
#   progress <step> <total> [label words...]
#
# The job's state lives in one line of one file, rewritten on every call. See
# README.md for the line format.
#
# A script that sets its own EXIT trap replaces the one installed here, so its
# trap must call `progress_done "$?"` to write the finished line.
#
# Every name defined here starts with _progress_ or PROGRESS_ so that it cannot
# collide with the sourcing script. Safe under set -euo pipefail and failglob.

PROGRESS_CLEANUP_MAX_FILES=500
PROGRESS_FINISHED_MAX_AGE_SECONDS=86400

# The builtin avoids forking date on every call.
_progress_epoch() {
    printf -v "$1" '%(%s)T' -1
}

_progress_warn() {
    printf "progress: cannot write '%s'\n" "$1" >&2
}

# A progress report must never kill the caller, so a failed write only warns.
# Failures are transient (I/O error, Windows sharing violation while a reader
# has the file open) and the next call rewrites the whole line anyway.
_progress_write() {
    local tmp="$_progress_file.tmp"
    if { printf '%s\n' "$1" > "$tmp" && mv -f "$tmp" "$_progress_file"; } 2>/dev/null; then
        return 0
    fi
    rm -f "$tmp" 2>/dev/null || true
    _progress_warn "$_progress_file"
    return 0
}

# Only finished files are removed: a running file may belong to a live job, and
# a file this helper cannot parse is not its to delete. The file count is
# capped so a crowded directory cannot delay the start of a script; the
# remainder waits for the next start.
_progress_cleanup() {
    local file started word code ended extra now count=0 glob_options files
    _progress_epoch now
    # The caller's glob options could make an empty directory an error
    # (failglob), so they are set here and put back.
    glob_options=$(shopt -p nullglob failglob) || true
    shopt -s nullglob
    shopt -u failglob
    files=("$_progress_dir"/*.txt)
    eval "$glob_options"
    # The guarded expansion keeps an empty array legal under set -u before Bash 4.4.
    for file in ${files[@]+"${files[@]}"}; do
        [[ -f $file ]] || continue
        if (( count >= PROGRESS_CLEANUP_MAX_FILES )); then
            break
        fi
        count=$((count + 1))
        started= word= code= ended= extra=
        { IFS=' ' read -r started word code ended extra < "$file"; } 2>/dev/null || true
        # Exit codes are signed because the directory may also hold files from
        # PowerShell scripts, where a crashed process reports a negative code.
        if [[ $word == done && -z $extra \
            && $started =~ ^[0-9]+$ && $code =~ ^-?[0-9]+$ && $ended =~ ^[0-9]{1,15}$ ]] \
            && (( now - 10#$ended > PROGRESS_FINISHED_MAX_AGE_SECONDS )); then
            rm -f "$file" 2>/dev/null || true
        fi
    done
    return 0
}

progress() {
    local IFS=' '
    local step=${1-} total=${2-}
    if [[ ! $step =~ ^[0-9]+$ || ! $total =~ ^[0-9]+$ ]]; then
        printf "progress: expected non-negative integers for step and total, got '%s' '%s'\n" \
            "$step" "$total" >&2
        return 2
    fi
    shift 2
    local label="$*"
    label=${label//$'\r'/ }
    label=${label//$'\n'/ }
    label=${label//$'\t'/ }
    _progress_write "$_progress_started $step $total${label:+ $label}"
}

progress_done() {
    local code=${1:-$?} now
    _progress_epoch now
    _progress_write "$_progress_started done $code $now"
}

_progress_name=${0##*/}
_progress_dir=${CLAUDE_PROGRESS_DIR:-$PWD/.claude/progress}
_progress_file="$_progress_dir/$_progress_name-$$.txt"
_progress_epoch _progress_started

mkdir -p "$_progress_dir" 2>/dev/null || _progress_warn "$_progress_dir"
_progress_cleanup
trap 'progress_done "$?"' EXIT
