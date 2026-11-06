# WorkScene Connector

Install this VSIX in **VS Code Stable on your local desktop**, then launch WorkScene.
The extension runs in the local UI extension host, including Remote SSH windows.
Every loaded window reports its actual workspace folders and focus state. Empty windows
are supported. No history, titles, or process counts are used to infer windows.

The status bar and `WorkScene: Show Connection Status` command show connection errors.
The app discovers this connector using a private file under its standard user data directory.
There are no ports or passwords to configure. Reports stay on 127.0.0.1.

Use a current VS Code Stable version. Exact activation requires the built-in
`workbench.action.focusWindow` command; capability detection hides this promise on older versions.
An executed command without observed focus is reported separately from confirmed activation.

The app and connector must run under the same local OS user. Install the extension locally,
not only on the SSH server. For SSH locations, explicitly map the Remote SSH alias in WorkScene.
Local checkout roots are verified with the system Git's read-only `rev-parse --show-toplevel`
command (2-second timeout), including when VS Code's Git API is absent or only knows a parent.
Optional branch metadata is read from the Git API when it matches the root. No workspace code is run. Disable the extension to stop reporting, or uninstall it to disconnect.
