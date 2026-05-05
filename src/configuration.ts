import * as vscode from "vscode";

/**
 * First section of all configuration values.
 */
export const configurationPrefix = "dumbLinks";

/** Returns whether the extension is enabled globally. */
export function enabledGlobally(): boolean {
  return vscode.workspace.getConfiguration(configurationPrefix).get<boolean>(
    "enable",
    true,
  );
}

/** Returns the rules enabled for the document at the given URI. */
export function rulesForDocument(uri: vscode.Uri): readonly Rule[] {
  const configuration = vscode.workspace.getConfiguration(
    configurationPrefix,
    uri,
  );
  if (!configuration.get<boolean>("enable", true)) return [];

  const rules: Rule[] = [];
  const overrides = configuration.get<Record<string, Override>>("overrides") ??
    {};

  for (const ruleName of ruleNames) {
    const {
      enable = true,
      ifCannotFindTarget = "warn-link",
      ifCannotReadFile = ruleName === "implicit" ? "ignore" : "error",
    } = overrides[ruleName] ?? {};
    if (!enable) continue;

    let fileNotFound: vscode.DiagnosticSeverity | undefined =
      vscode.DiagnosticSeverity.Error;

    switch (ifCannotReadFile) {
      case "ignore":
        fileNotFound = undefined;
        break;
      case "warn":
        fileNotFound = vscode.DiagnosticSeverity.Warning;
        break;
      case "error":
        fileNotFound = vscode.DiagnosticSeverity.Error;
        break;
    }

    let targetNotFound: vscode.DiagnosticSeverity | undefined =
      vscode.DiagnosticSeverity.Warning;
    let targetNotFoundLink = true;

    switch (ifCannotFindTarget) {
      case "ignore":
        targetNotFound = undefined;
        targetNotFoundLink = false;
        break;
      case "warn":
        targetNotFound = vscode.DiagnosticSeverity.Warning;
        targetNotFoundLink = false;
        break;
      case "error":
        targetNotFound = vscode.DiagnosticSeverity.Error;
        targetNotFoundLink = false;
        break;
      case "link":
        targetNotFound = undefined;
        break;
      case "warn-link":
        targetNotFound = vscode.DiagnosticSeverity.Warning;
        break;
      case "error-link":
        targetNotFound = vscode.DiagnosticSeverity.Error;
        break;
    }

    rules.push({
      name: ruleName,
      fileNotFound,
      targetNotFound,
      targetNotFoundLink,
    });
  }

  return rules;
}

const ruleNames = ["implicit", "absolute", "relative"] as const;

export interface Rule {
  /** The name of the rule. */
  readonly name: Rule.Name;

  /**
   * Severity of the diagnostic to emit if the target file cannot be opened; if undefined, no
   * diagnostic is emitted.
   */
  readonly fileNotFound: vscode.DiagnosticSeverity | undefined;
  /**
   * Severity of the diagnostic to emit if the target symbol or text cannot be found; if undefined,
   * no diagnostic is emitted.
   */
  readonly targetNotFound: vscode.DiagnosticSeverity | undefined;

  /** Whether to add a link even if the target symbol or text cannot be found. */
  readonly targetNotFoundLink: boolean;
}

export declare namespace Rule {
  export type Name = typeof ruleNames[number];
}

/** See `../package.json#:~:text=dumbLinks.overrides`. */
interface Override {
  readonly enable: boolean;
  readonly ifCannotReadFile: "ignore" | "warn" | "error";
  readonly ifCannotFindTarget:
    | "ignore"
    | "warn"
    | "error"
    | "link"
    | "warn-link"
    | "error-link";
}
