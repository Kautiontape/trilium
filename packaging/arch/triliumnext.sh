#!/bin/bash
# Launcher for the ktn fork build of Trilium Notes.
#
# Adapted from the AUR `triliumnext-bin` launcher so that behaviour, flag files and
# window grouping stay identical when swapping between the two packages.
set -e

_APPDIR="/usr/lib/triliumnext"
_RUNNAME="${_APPDIR}/app.asar"
_ELECTRON="@ELECTRON_BIN@"

export ELECTRON_IS_DEV=0
export ELECTRON_FORCE_IS_PACKAGED=true
export ELECTRON_DISABLE_SECURITY_WARNINGS=true
export NODE_ENV=production
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export LD_LIBRARY_PATH="${_APPDIR}/lib:${LD_LIBRARY_PATH}"

# Let modern Electron pick X11 vs Wayland itself — fixes decorations and fractional scaling.
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"

# Match the .desktop file so the taskbar groups windows correctly.
export CHROME_DESKTOP="triliumnext.desktop"

# Electron's trash implementation differs per desktop environment.
case "${XDG_CURRENT_DESKTOP}" in
    KDE) export ELECTRON_TRASH="kioclient5" ;;
    GNOME) export ELECTRON_TRASH="gio" ;;
    XFCE) export ELECTRON_TRASH="gvfs-trash" ;;
    *) ;;
esac

# User-supplied flags, later files appending to earlier ones.
_FLAG_SOURCES=(
    "${XDG_CONFIG_HOME}/electron-flags.conf"
    "${XDG_CONFIG_HOME}/@ELECTRON_BIN@-flags.conf"
    "${XDG_CONFIG_HOME}/triliumnext-flags.conf"
    "${XDG_CONFIG_HOME}/TriliumNotes/triliumnext-flags.conf"
)

declare -a flags
for _FLAGS_FILE in "${_FLAG_SOURCES[@]}"; do
    if [[ -f "${_FLAGS_FILE}" ]]; then
        while read -r line || [[ -n "$line" ]]; do
            [[ "${line}" =~ ^[[:space:]]*#.* ]] || [[ -z "${line}" ]] || {
                read -ra line_flags <<< "$line"
                flags+=("${line_flags[@]}")
            }
        done < "${_FLAGS_FILE}"
    fi
done

# Electron refuses to sandbox as root unless told otherwise.
_SANDBOX_ARG=()
if [[ "${EUID}" -eq 0 ]] && [[ "${ELECTRON_RUN_AS_NODE}" != "1" ]]; then
    _SANDBOX_ARG=("--no-sandbox")
fi

cd "${_APPDIR}"
exec "${_ELECTRON}" "${flags[@]}" "${_SANDBOX_ARG[@]}" "${_RUNNAME}" "$@"
