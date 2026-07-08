#!/usr/bin/env bash
set -euo pipefail

capture_dir=""
browser_path="${BROWSER_PATH:-}"
browser_command="${BROWSER_COMMAND:-google-chrome}"

usage() {
	cat <<'EOF'
Usage: start-browser-cdp.sh [options]

Options:
  --capture-dir <dir>       Capture directory. Defaults to a timestamped run.
  --browser-path <path>     Browser executable path.
  --browser-command <name>  Browser command on PATH. Defaults to google-chrome.
  --help                    Show help.
EOF
}

timestamp() {
	date -u '+%Y-%m-%dT%H-%M-%S'
}

base_dir() {
	if [[ -n "${CDP_RESPONSE_LOGGER_BASE_DIR:-}" ]]; then
		printf '%s\n' "${CDP_RESPONSE_LOGGER_BASE_DIR}"
		return
	fi

	case "$(uname -s)" in
		Darwin)
			printf '%s\n' "${HOME}/Library/Application Support/ChromeCdpResponseLogger"
			;;
		*)
			printf '%s\n' "${XDG_STATE_HOME:-${HOME}/.local/state}/ChromeCdpResponseLogger"
			;;
	esac
}

while (($#)); do
	case "$1" in
		--capture-dir)
			capture_dir="${2:?missing value for --capture-dir}"
			shift 2
			;;
		--browser-path)
			browser_path="${2:?missing value for --browser-path}"
			shift 2
			;;
		--browser-command)
			browser_command="${2:?missing value for --browser-command}"
			shift 2
			;;
		--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			usage >&2
			exit 2
			;;
	esac
done

base="$(base_dir)"
profile_dir="${base}/browser-profile"
captures_dir="${base}/captures"
bin_dir="${base}/bin"

mkdir -p "${profile_dir}" "${captures_dir}" "${bin_dir}"

if [[ -z "${capture_dir}" ]]; then
	capture_dir="${captures_dir}/$(timestamp)"
fi
mkdir -p "${capture_dir}"

if [[ -n "${browser_path}" ]]; then
	if [[ ! -x "${browser_path}" ]]; then
		echo "Browser executable was not found or is not executable: ${browser_path}" >&2
		exit 1
	fi
	browser="${browser_path}"
elif command -v "${browser_command}" >/dev/null 2>&1; then
	browser="$(command -v "${browser_command}")"
else
	echo "Browser command was not found on PATH: ${browser_command}. Add it to PATH or pass --browser-path." >&2
	exit 1
fi

netlog_path="${capture_dir}/netlog.json"
"${browser}" \
	"--user-data-dir=${profile_dir}" \
	--remote-debugging-address=127.0.0.1 \
	--remote-debugging-port=9222 \
	"--log-net-log=${netlog_path}" \
	--net-log-capture-mode=Everything \
	>/dev/null 2>&1 &

printf 'Browser: %s\n' "${browser}"
printf 'Profile directory: %s\n' "${profile_dir}"
printf 'Capture directory: %s\n' "${capture_dir}"
printf 'CDP endpoint: http://127.0.0.1:9222\n'
printf 'NetLog: %s\n' "${netlog_path}"
