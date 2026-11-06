import { Environment, FolderReport, SessionReport } from "../core/domain";

// Only this adapter understands VS Code remote authority formats.
export function resolveVSCodeFolder(
  folder: FolderReport,
  environments: Environment[],
): { environment: Environment; directory: string } | undefined {
  const uri = new URL(folder.uri);
  const authority = decodeURIComponent(uri.host);
  const environment =
    uri.protocol === "file:" && !uri.host
      ? environments.find((e) => e.kind === "local")
      : uri.protocol === "vscode-remote:" && authority.startsWith("ssh-remote+")
        ? environments.find(
            (e) => e.kind === "ssh" && e.aliases.includes(authority.slice(11)),
          )
        : undefined;
  if (!environment) return undefined;
  const directory =
    folder.canonicalPath && environment.kind === "local"
      ? folder.canonicalPath
      : decodeURIComponent(uri.pathname);
  return { environment, directory };
}

export const vscodeCLI = (platform: NodeJS.Platform) =>
  platform === "darwin"
    ? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    : "code";
export function openLocationArguments(
  environment: Environment,
  directory: string,
): string[] {
  return environment.kind === "local"
    ? ["--new-window", "--", directory]
    : [
        "--new-window",
        "--remote",
        `ssh-remote+${environment.aliases[0] || environment.target}`,
        "--",
        directory,
      ];
}

export function validateReport(value: unknown): asserts value is SessionReport {
  const r = value as SessionReport;
  if (
    !r ||
    r.protocol !== 1 ||
    r.tool !== "vscode-stable" ||
    typeof r.instanceId !== "string" ||
    !/^[a-zA-Z0-9-]{8,100}$/.test(r.instanceId) ||
    typeof r.toolVersion !== "string" ||
    typeof r.workspaceName !== "string" ||
    typeof r.focused !== "boolean" ||
    !Array.isArray(r.folders) ||
    r.folders.length > 200 ||
    !Array.isArray(r.capabilities) ||
    r.capabilities.some((c) => c !== "activateSession")
  )
    throw new Error("会话协议格式或版本无效");
  for (const f of r.folders)
    if (
      !f ||
      typeof f.uri !== "string" ||
      f.uri.length > 16000 ||
      (f.canonicalPath !== undefined &&
        (typeof f.canonicalPath !== "string" ||
          !f.canonicalPath.startsWith("/"))) ||
      (f.checkoutRoot !== undefined &&
        (typeof f.checkoutRoot !== "string" || !f.checkoutRoot.startsWith("/")))
    )
      throw new Error("目录报告格式无效");
}
