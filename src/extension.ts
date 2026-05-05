import * as vscode from "vscode";
import {
  configurationPrefix,
  enabledGlobally,
  Rule,
  rulesForDocument,
} from "./configuration";

/**
 * ID of the command used to open a document via {@linkcode vscode.window.showTextDocument()}
 * when its URI does not support specific ranges.
 */
const openCommand = `${configurationPrefix}.openAtRange`;

export function activate(context: vscode.ExtensionContext): void {
  const toggle = () => {
    // We always have one subscription to listen to the configuration, and more if we are enabled.
    const isEnabled = context.subscriptions.length > 1;

    if (enabledGlobally()) {
      if (!isEnabled) enable(context);
    } else if (isEnabled) {
      disable();

      for (const subscription of context.subscriptions.splice(1)) {
        subscription.dispose();
      }
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(configurationPrefix)) toggle();
    }),
  );

  toggle();
}

export function deactivate(): void {
  disable();
}

function enable(context: vscode.ExtensionContext): void {
  const diagnosticsCollection = vscode.languages.createDiagnosticCollection(
    context.extension.id,
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider({ pattern: "**/*" }, {
      async provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
      ): Promise<vscode.DocumentLink[] | undefined> {
        const rules = rulesForDocument(document.uri);
        if (rules.length === 0) return;

        const rulesByName = Object.fromEntries(
          rules.map((rule) => [rule.name, rule]),
        );
        const documentUriString = document.uri.toString();
        const resolver = new LinkResolver(
          documentUriString,
          rulesByName,
          token,
        );

        resolver.scanLines(document);

        await resolver.resolveFoundReferences();

        if (token.isCancellationRequested) {
          return;
        }

        diagnosticsCollection.set(document.uri, resolver.diagnostics);

        return resolver.links;
      },
    }),
    diagnosticsCollection,
    //
    // Open the document at the proper range.
    vscode.commands.registerCommand(
      openCommand,
      async ({ uri, line, column }: OpenCommandArgs) => {
        const position = new vscode.Position(line - 1, column - 1);

        await vscode.window.showTextDocument(
          vscode.Uri.parse(uri, /*strict=*/ true),
          { selection: new vscode.Range(position, position) },
        );
      },
    ),
    //
    // Clean up caches on document changes.
    //
    // In theory we could use `vscode.workspace.createFileSystemWatcher()` here, but it's not worth
    // creating a whole file system watcher per referenced document just to properly update links.
    vscode.workspace.onDidCloseTextDocument((document) => {
      const uriString = document.uri.toString();

      // Remove memory related to this document.
      documentCache.delete(uriString);
      referencedDocumentCache.delete(uriString);

      // Do not clean up references to that document; it's perfectly valid to refer to the contents
      // of this document even while it is closed.
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      const uriString = document.uri.toString();
      const cache = referencedDocumentCache.get(uriString);
      if (cache === undefined) return;

      referencedDocumentCache.delete(uriString);

      // Remove all references from the cache.
      for (const [uri, referenceTexts] of cache) {
        const cache = documentCache.get(uri)!;

        for (const referenceText of referenceTexts) {
          cache.references.delete(referenceText);
        }

        if (cache.references.size === 0) {
          documentCache.delete(uri);
        }
      }
    }),
  );
}

function disable(): void {
  documentCache.clear();
  referencedDocumentCache.clear();
}

// -------------------------------------------------------------------------------------------------
// MARK: LinkResolver

const linkRegExp = (() => {
  // Only allow paths preceeded by whitespace or some allowed characters. Notably, don't allow paths
  // in quotes, as those are likely either not relative paths, or part of the language (which will
  // provide better linking).
  const prefix = /(?<=^|[\s([`])/;

  // Make sure not to accept separators (e.g. `#`, `:`), glob characters (e.g. `?`, `*`).
  const pathSegment = /[\w.-]+/;
  const path = new RegExp(
    `(?<path>(?:${pathSegment.source}|/)(?:/${pathSegment.source})+)`,
  );

  // Matches `line` or `line:column`.
  const lineColumn = /(?<line>\d+)(?::(?<column>\d+))?/;

  // Matches a symbol.
  const symbolPath = /(?<symbol>[\w!?$@~.-]+)/;

  // Matches a text fragment; see
  // https://developer.mozilla.org/docs/Web/URI/Reference/Fragment/Text_fragments#syntax.
  const textFragment = /:~:text=(?<fragment>\S+)/;

  return new RegExp(
    `${prefix.source}${path.source}(?::${lineColumn.source}|#(?:${textFragment.source}|${symbolPath.source})?)?(?!/)\\b`,
    "gu",
  );
})();

class LinkResolver {
  public readonly links: vscode.DocumentLink[] = [];
  public readonly diagnostics: vscode.Diagnostic[] = [];

  private readonly referencedDocuments = new Map<string, ReferencedDocument>();
  private readonly cachedDocument: DocumentCache;

  public constructor(
    private readonly uriString: string,
    private readonly rules: { readonly [_ in Rule.Name]?: Rule },
    private readonly token: vscode.CancellationToken,
  ) {
    this.cachedDocument = getOrCreate(
      documentCache,
      uriString,
      () => ({ references: new Map() }),
    );

    for (const entry of this.cachedDocument.references.values()) {
      entry.keep = false;
    }
  }

  // -----------------------------------------------------------------------------------------------
  // MARK: Line scanning

  public scanLines(document: vscode.TextDocument): void {
    for (
      let lineNumber = 0;
      lineNumber < document.lineCount;
      lineNumber++
    ) {
      this.scanLine(document, lineNumber);
    }
  }

  private scanLine(document: vscode.TextDocument, lineNumber: number): void {
    const line = document.lineAt(lineNumber);

    for (const match of line.text.matchAll(linkRegExp)) {
      const matchText = trimSuffix(match[0]);

      const ruleName: Rule.Name = matchText.startsWith("/")
        ? "absolute"
        : matchText.startsWith("./") || matchText.startsWith("../")
        ? "relative"
        : "implicit";
      const rule = this.rules[ruleName];
      if (rule === undefined) continue;

      if (
        !matchText.startsWith(".") && !matchText.startsWith("/") &&
        !matchText.slice(matchText.lastIndexOf("/") + 1).includes(".")
      ) {
        // For paths that don't start with `.` or `/`, require the last segment (filename) to have
        // an extension (or to start with a `.`).
        continue;
      }

      const matchCache = this.cachedDocument.references.get(matchText);

      const range = new vscode.Range(
        new vscode.Position(lineNumber, match.index),
        new vscode.Position(lineNumber, match.index + matchText.length),
      );

      if (matchCache !== undefined) {
        if (matchCache.diagnostic !== undefined) {
          this.diagnostics.push(matchCache.diagnostic);
        }
        if (matchCache.target !== undefined) {
          this.links.push(new vscode.DocumentLink(range, matchCache.target));
        }
        matchCache.keep = true;
        continue;
      }

      // Parse reference.
      const { path, line, column, symbol, fragment } = match.groups!;
      let targetUri: vscode.Uri;

      if (path.startsWith("//")) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (workspaceFolder === undefined) {
          this.diagnostics.push(
            new vscode.Diagnostic(
              range,
              `Cannot use absolute link \`${path}\` outside of a workspace.`,
              rule.fileNotFound,
            ),
          );
          continue;
        }

        targetUri = vscode.Uri.joinPath(workspaceFolder.uri, path.slice(2));
      } else {
        targetUri = vscode.Uri.joinPath(document.uri, "..", path);
      }
      const targetString = targetUri.toString();

      let target: Reference.Target;

      if (line !== undefined) {
        // Handle `:<line>` syntax.
        target = new vscode.Position(+line - 1, +(column ?? 1) - 1);
      } else if (symbol !== undefined) {
        // Handle `#<symbol>` syntax.
        target = trimSuffix(symbol);
      } else if (fragment !== undefined) {
        // Handle `#:~:text=<fragment>` syntax.
        const parsed = parseTextFragment(trimSuffix(fragment));

        if (typeof parsed === "string") {
          const diagnosticEnd = match.index + matchText.length;
          const diagnosticStart = diagnosticEnd - fragment.length;

          const brokenReference: Reference = {
            range,
            target: undefined,
            text: matchText,
            rule,
          };

          this.diagnoseTargetNotFound(
            targetUri,
            parsed,
            brokenReference,
            getOrCreate(
              referencedDocumentCache,
              targetString,
              () => new Map(),
            ),
            new vscode.Range(
              new vscode.Position(lineNumber, diagnosticStart),
              new vscode.Position(lineNumber, diagnosticEnd),
            ),
          );

          continue;
        }

        target = parsed;
      } else {
        // Plain link -- we only care about whether or not the file exists.
        target = undefined;
      }

      getOrCreate(this.referencedDocuments, targetString, () => ({
        uri: targetUri,
        references: [],
      })).references.push({ range, target, text: matchText, rule });
    }
  }

  // -----------------------------------------------------------------------------------------------
  // MARK: Link resolution

  public async resolveFoundReferences(): Promise<void> {
    // Process all documents concurrently.
    await Promise.all(
      Array.from(
        this.referencedDocuments.values(),
        (uri) => this.resolveReferencesTo(uri),
      ),
    );

    // Remove unused cache entries.
    for (const [key, entry] of this.cachedDocument.references) {
      if (!entry.keep) {
        this.cachedDocument.references.delete(key);
      }
    }
  }

  private async resolveReferencesTo(
    { uri, references }: ReferencedDocument,
  ): Promise<void> {
    // Clean up cache.
    const uriString = uri.toString();
    const referenceCache = getOrCreate(
      referencedDocumentCache,
      uriString,
      () => new Map(),
    );

    // Build a tree of all references to match against the symbol hierarchy.
    const symbolTree = new Map<string, SymbolTree>();
    const withPositions: Reference<vscode.Position | undefined>[] = [];
    const withTextFragments: Reference<TextFragment>[] = [];

    for (const reference of references) {
      if (typeof reference.target !== "string") {
        if (
          reference.target === undefined ||
          reference.target instanceof vscode.Position
        ) {
          withPositions.push(
            reference as Reference<vscode.Position | undefined>,
          );
        } else {
          withTextFragments.push(reference as Reference<TextFragment>);
        }
        continue;
      }

      const parts = reference.target.split(".");
      let node: Map<string, SymbolTree> = symbolTree;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];

        node = getOrCreate(
          node,
          part,
          () => ({ references: [], children: new Map() }),
        ).children;
      }

      getOrCreate(
        node,
        parts[parts.length - 1],
        () => ({ references: [], children: new Map() }),
      ).references.push(reference as Reference<string>);
    }

    const promises: Promise<void>[] = [];

    if (symbolTree.size > 0) {
      promises.push(this.resolveSymbols(uri, symbolTree, referenceCache));
    }
    if (withTextFragments.length > 0) {
      promises.push(
        this.resolveTextFragments(
          uri,
          withTextFragments,
          withPositions,
          referenceCache,
        ),
      );
    } else if (withPositions.length > 0) {
      promises.push(this.resolvePositions(uri, withPositions, referenceCache));
    }

    await Promise.all(promises);
  }

  // -----------------------------------------------------------------------------------------------
  // MARK: TextFragment resolution

  private async resolveTextFragments(
    uri: vscode.Uri,
    references: readonly Reference<TextFragment>[],
    positions: readonly Reference<vscode.Position | undefined>[],
    referenceCache: Map<string, Set<string>>,
  ): Promise<void> {
    // Read file, prioritizing the one currently loaded by VS Code.
    const document = documentAt(uri);
    const documentText = document?.getText() ?? await readFileText(uri);

    if (documentText instanceof Error) {
      this.diagnoseFileNotFound(uri, documentText, references);
      if (positions.length > 0) {
        this.diagnoseFileNotFound(uri, documentText, positions);
      }
      return;
    }

    if (positions.length > 0) {
      this.resolvePositionsIn(
        uri,
        document ?? documentText,
        positions,
        referenceCache,
      );
    }

    // Compile text fragments into one `RegExp`. In theory we could just use `indexOf()` with each
    // fragment, but we need to be case-insensitive, so `indexOf()` would require us to copy the
    // document text with `toLowerCase()`. To avoid this, we can convert each fragment into a
    // `RegExp` with `i` flag. But we can do even better: we can put all the fragments into a single
    // `RegExp` and search all of them at once.
    const remainingFragments = references.map((reference) => {
      const fragment = reference.target;
      const re = fragment.textEnd === ""
        ? RegExp.escape(fragment.textStart)
        : `${RegExp.escape(fragment.textStart)}[\\s\\S]+?${
          RegExp.escape(fragment.textEnd)
        }`;

      return { reference, re };
    });

    let currentLine = 0;
    let offsetInLine = 0;
    let remainingText = documentText;

    while (remainingFragments.length > 0) {
      // Concatenate all fragments into one `RegExp`.
      const regexp = new RegExp(
        `(${remainingFragments.map(({ re }) => re).join(")|(")})`,
        "i",
      );
      const match = remainingText.match(regexp);

      if (match === null) {
        // No more fragments match.
        for (const { reference } of remainingFragments) {
          this.diagnoseTargetNotFound(
            uri,
            `Cannot find \`${reference.text}\` in \`${uri.toString(true)}\`.`,
            reference,
            referenceCache,
          );
        }
        return;
      }

      // Advance text to make subsequent searches faster.
      const skippedText = remainingText.slice(0, match.index);
      const lastNewLine = skippedText.lastIndexOf("\n");

      if (lastNewLine === -1) {
        offsetInLine += skippedText.length;
      } else {
        currentLine += 1 + countNewLines(remainingText.slice(0, lastNewLine));
        offsetInLine = skippedText.length - (lastNewLine + 1);
      }
      remainingText = remainingText.slice(match.index);

      // We have a match; find the corresponding fragment.
      const matchingIndex = match.findIndex((text, i) =>
        text !== undefined && i > 0
      ) - 1; // Skip the full match at index 0.
      const matchingFragment = remainingFragments[matchingIndex];

      this.addLink(
        matchingFragment.reference,
        uri,
        currentLine,
        offsetInLine,
        referenceCache,
      );

      // Swap-remove the fragment.
      if (matchingIndex !== remainingFragments.length - 1) {
        remainingFragments[matchingIndex] = remainingFragments.pop()!;
      } else {
        remainingFragments.pop();
      }
    }
  }

  // -----------------------------------------------------------------------------------------------
  // MARK: Symbol resolution

  private async resolveSymbols(
    uri: vscode.Uri,
    symbolTree: Map<string, SymbolTree>,
    referenceCache: Map<string, Set<string>>,
  ): Promise<void> {
    // Match the document symbols against the reference tree, removing found references from the
    // tree.
    const symbols = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >("vscode.executeDocumentSymbolProvider", uri);

    if (this.token.isCancellationRequested) {
      // Don't update the results; this may race with a new request.
      return;
    }

    for (const symbol of symbols) {
      this.resolveSymbolsRecursively(uri, symbol, symbolTree, referenceCache);
    }

    // Every remaining reference in the tree is unresolved; diagnose them.
    this.diagnoseMissing(uri, symbolTree, referenceCache);
  }

  private resolveSymbolsRecursively(
    uri: vscode.Uri,
    symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
    symbolTree: Map<string, SymbolTree>,
    referenceCache: Map<string, Set<string>>,
  ): void {
    const symbolName = cleanUpSymbolName(symbol.name);
    const match = symbolTree.get(symbolName);

    if (match === undefined) {
      // If we can't find the symbol at this scope, we try recursively in child scopes. This is
      // notably important in Markdown, where headers are nested based on the number of `#`s, but we
      // want to jump to the first header matching `symbolName`, no matter its depth.
      if ("children" in symbol) {
        for (const child of symbol.children) {
          this.resolveSymbolsRecursively(
            uri,
            child,
            symbolTree,
            referenceCache,
          );
        }
      }

      return;
    }

    const startPosition = "selectionRange" in symbol
      ? symbol.selectionRange.start // Prefer `selectionRange`.
      : symbol.location.range.start;

    for (const reference of match.references) {
      this.addLink(
        reference,
        uri,
        startPosition.line,
        startPosition.character,
        referenceCache,
      );
    }

    match.references.length = 0;

    if ("children" in symbol) {
      for (const child of symbol.children) {
        this.resolveSymbolsRecursively(
          uri,
          child,
          match.children,
          referenceCache,
        );
      }
    }

    if (match.children.size === 0) {
      symbolTree.delete(symbolName);
    }
  }

  private diagnoseMissing(
    uri: vscode.Uri,
    tree: ReadonlyMap<string, SymbolTree>,
    referenceCache: Map<string, Set<string>>,
  ): void {
    for (const [_, node] of tree) {
      for (const reference of node.references) {
        this.diagnoseTargetNotFound(
          uri,
          `Unresolved reference: \`${reference.target}\`.`,
          reference,
          referenceCache,
        );
      }

      this.diagnoseMissing(uri, node.children, referenceCache);
    }
  }

  // -----------------------------------------------------------------------------------------------
  // MARK: Position checking

  private async resolvePositions(
    uri: vscode.Uri,
    references: readonly Reference<vscode.Position | undefined>[],
    referenceCache: Map<string, Set<string>>,
  ): Promise<void> {
    const document = documentAt(uri);

    if (document !== undefined) {
      this.resolvePositionsIn(
        uri,
        document,
        references,
        referenceCache,
      );
      return;
    }

    if (
      references.every((r) =>
        r.target === undefined || r.target.line + r.target.character === 0
      )
    ) {
      // We only care about whether the file exists, so we don't need to read it.
      try {
        const stat = await vscode.workspace.fs.stat(uri);

        if (
          stat.type !== vscode.FileType.File &&
          stat.type !== vscode.FileType.SymbolicLink
        ) {
          throw new Error(`not a file`);
        }

        for (const reference of references) {
          if (reference.target === undefined) {
            this.addLink(reference, uri, -1, -1, referenceCache);
          } else {
            this.addLink(reference, uri, 0, 0, referenceCache);
          }
        }
      } catch (e) {
        this.diagnoseFileNotFound(uri, e as Error, references);
      }
      return;
    }

    const documentText = await readFileText(uri);

    if (documentText instanceof Error) {
      this.diagnoseFileNotFound(uri, documentText, references);
    } else {
      this.resolvePositionsIn(uri, documentText, references, referenceCache);
    }
  }

  private resolvePositionsIn(
    uri: vscode.Uri,
    document: vscode.TextDocument | string,
    references: readonly Reference<vscode.Position | undefined>[],
    referenceCache: Map<string, Set<string>>,
  ): void {
    // Sort references to access lines from the top of the document.
    const sortedReferences = references.filter(
      (r): r is Reference<vscode.Position> => {
        if (
          r.target === undefined || r.target.line + r.target.character === 0
        ) {
          // File exists, no need to check it.
          if (r.target === undefined) {
            this.addLink(r, uri, -1, -1, referenceCache);
          } else {
            this.addLink(r, uri, 0, 0, referenceCache);
          }

          return false;
        }
        return true;
      },
    ).sort((a, b) => a.target.compareTo(b.target));

    if (sortedReferences.length === 0) return;

    // Set up logic to advance lines.
    let lineLengthOf: (line: number) => number;

    if (typeof document === "string") {
      const lines = document.split("\n");

      lineLengthOf = (line) => line < lines.length ? lines[line].length : -1;
    } else {
      let lastLine = 0;
      let lastLineLength = document.lineCount === 0
        ? 0
        : document.lineAt(0).range.end.character;

      lineLengthOf = (line) => {
        if (line >= document.lineCount) return -1;
        if (line < lastLine) {
          lastLine = line;
          lastLineLength = document.lineAt(line).range.end.character;
        }
        return lastLineLength;
      };
    }

    let currentReference = 0;

    while (currentReference < sortedReferences.length) {
      const reference = sortedReferences[currentReference];
      const { line, character } = reference.target;
      const lineLength = lineLengthOf(line);

      // Check that we're in range. `lineLength` is -1 if the line is out of range, in which case
      // the check below will fail.
      if (character >= lineLength) break;

      this.addLink(reference, uri, line, character, referenceCache);

      currentReference++;
    }

    // All remaining references are out of range.
    while (currentReference < sortedReferences.length) {
      const reference = sortedReferences[currentReference++];

      this.diagnoseTargetNotFound(
        uri,
        `Position ${reference.target.line + 1}:${
          reference.target.character + 1
        } out of range`,
        reference,
        referenceCache,
      );
    }
  }

  // -----------------------------------------------------------------------------------------------
  // MARK: Helpers

  /**
   * @param targetLine 0-indexed. If -1, no target position is added to the URI.
   * @param targetColumn 0-indexed.
   */
  private addLink(
    reference: Reference,
    target: vscode.Uri,
    targetLine: number,
    targetColumn: number,
    referenceCache: Map<string, Set<string>>,
  ): void {
    const link = new vscode.DocumentLink(
      reference.range,
      targetLine === -1 ? target : at(target, targetLine + 1, targetColumn + 1),
    );

    this.links.push(link);
    this.cachedDocument.references.set(reference.text, {
      target: link.target!,
      keep: true,
    });

    getOrCreate(referenceCache, this.uriString, () => new Set()).add(
      reference.text,
    );
  }

  private diagnoseTargetNotFound(
    uri: vscode.Uri,
    message: string,
    reference: Reference,
    referenceCache: Map<string, Set<string>>,
    diagnosticRange = reference.range,
  ): void {
    if (reference.rule.targetNotFoundLink) {
      this.addLink(reference, uri, -1, -1, referenceCache);
    }

    if (reference.rule.targetNotFound !== undefined) {
      // Add the diagnostic _after_ the link, since both will modify the cache, and only _we_ handle
      // the case where we need a diagnostic as well.
      const diagnostic = new vscode.Diagnostic(
        diagnosticRange,
        message,
        reference.rule.targetNotFound,
      );

      this.diagnostics.push(diagnostic);
      this.cachedDocument.references.set(reference.text, {
        diagnostic,
        target: reference.rule.targetNotFoundLink ? uri : undefined,
        keep: true,
      });
    }
  }

  private diagnoseFileNotFound(
    uri: vscode.Uri,
    error: Error,
    references: readonly Reference[],
  ): void {
    const message = `Cannot read \`${uri.toString(true)}\`: ${error.message}.`;

    for (const reference of references) {
      if (reference.rule.fileNotFound !== undefined) {
        this.diagnostics.push(
          new vscode.Diagnostic(
            reference.range,
            message,
            reference.rule.fileNotFound,
          ),
        );
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------
// MARK: Helpers

const documentCache = new Map<string, DocumentCache>();
const referencedDocumentCache = new Map<string, Map<string, Set<string>>>();

/** Returns an URI pointing at `uri` at line `line` / `column` (1-indexed). */
function at(uri: vscode.Uri, line: number, column: number): vscode.Uri {
  if (uri.scheme === "file") {
    return uri.with({ fragment: `${line},${column}` });
  }
  if (uri.scheme === "http" || uri.scheme === "https") {
    return uri.with({ fragment: `L${line}` });
  }

  // We are using an unknown scheme and we don't know how to point to a specific position, so
  // instead we generate an URI which executes the `openCommand`, which uses
  // `vscode.window.showTextDocument()` to display a document at a specific position.
  //
  // Supporting non-`file` URIs may sound a bit niche, but these are actually quite common, e.g.
  // when connected to remote workspaces.
  return vscode.Uri.from({
    scheme: "command",
    path: openCommand,
    query: encodeURIComponent(
      JSON.stringify(
        { uri: uri.toString(), line, column } satisfies OpenCommandArgs,
      ),
    ),
  });
}

/** Parses a {@linkcode TextFragment}; if invalid, returns an error message. */
function parseTextFragment(fragment: string): TextFragment | string {
  // https://developer.mozilla.org/docs/Web/URI/Reference/Fragment/Text_fragments#syntax.
  const parts = fragment.split(",");

  let prefix = "";
  let suffix = "";

  if (parts.length > 1 && parts[0].endsWith("-")) {
    prefix = decodeURIComponent(parts.shift()!);
  }
  if (parts.length > 1 && parts[parts.length - 1].startsWith("-")) {
    suffix = decodeURIComponent(parts.pop()!);
  }

  if (parts.length > 2) {
    return "Too many parts (separated by `,`) in text fragment.";
  }

  const textStart = decodeURIComponent(parts[0]);
  const textEnd = parts.length === 1 ? "" : decodeURIComponent(parts[1]);

  return { prefix, suffix, textStart, textEnd };
}

/** Returns whether `a` and `b` are equal. */
function uriEq(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.scheme === b.scheme && a.authority === b.authority &&
    a.path === b.path && a.query === b.query && a.fragment === b.fragment;
}

/** Returns the number of newline characters `\n` in `str`. */
function countNewLines(str: string): number {
  let offset = 0;
  let newLines = 0;

  for (;;) {
    offset = str.indexOf("\n", offset) + 1;

    if (offset === 0) return newLines;

    newLines++;
  }
}

/** Removes suffix which can come after a symbol or fragment if it appears in a sentence (`().`). */
function trimSuffix(str: string): string {
  const endIndex = str.search(/[().`]+$/);

  return endIndex === -1 ? str : str.slice(0, endIndex);
}

/** Cleans up a symbol name for resolution. */
function cleanUpSymbolName(name: string): string {
  // Markdown headings have `#` at the start of their name, which makes it impossible to refer to
  // them.
  return name.replace(/^#+/, "").trim().replace(/\s+/g, "-");
}

/** Returns the loaded document at the given URI, if any. */
function documentAt(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((document) =>
    uriEq(document.uri, uri)
  );
}

/** Reads the file at the given URI, returning an error on error. */
async function readFileText(uri: vscode.Uri): Promise<string | Error> {
  try {
    const documentBytes = await vscode.workspace.fs.readFile(uri);

    return vscode.workspace.decode(documentBytes, { uri });
  } catch (e) {
    return e as Error;
  }
}

/** Returns the value associated with `key`, creating it with `createValue()` and inserting it first if absent. */
function getOrCreate<K, V>(map: Map<K, V>, key: K, createValue: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const newValue = createValue();
  map.set(key, newValue);
  return newValue;
}

// -------------------------------------------------------------------------------------------------
// MARK: Interfaces

interface ReferencedDocument {
  /** URI of the document. */
  readonly uri: vscode.Uri;
  /** References to that document. */
  readonly references: Reference[];
}

interface Reference<Target extends Reference.Target = Reference.Target> {
  /** Range in the _referencing document_ (*not* the referenced document) where the reference is. */
  readonly range: vscode.Range;
  /** Text of the reference; used for caching. */
  readonly text: string;
  /** The target symbol path, text fragment, or position. */
  readonly target: Target;
  /** The rule which created this reference. */
  readonly rule: Rule;
}

declare namespace Reference {
  /** A target symbol path (`string`), text fragment, position, or nothing (file must simply exist). */
  type Target = string | TextFragment | vscode.Position | undefined;
}

/** A referenced [text fragment](https://developer.mozilla.org/docs/Web/URI/Reference/Fragment/Text_fragments). */
interface TextFragment {
  readonly textStart: string;
  readonly textEnd: string;
  readonly prefix: string;
  readonly suffix: string;
}

/** Cache kept for a {@linkcode vscode.TextDocument}. */
interface DocumentCache {
  /** Map from reference text to its resolved URI (or diagnostic if it cannot be resolved). */
  readonly references: Map<
    string,
    {
      readonly target?: vscode.Uri;
      readonly diagnostic?: vscode.Diagnostic;

      /** Set to false when loading the cache, and to true when the cache is used. */
      keep: boolean;
    }
  >;
}

/** A recursive tree of symbols. */
interface SymbolTree {
  /** References to that symbol. */
  readonly references: Reference<string>[];
  /** Map from path segment (identifier) to tree for that symbol. */
  readonly children: Map<string, SymbolTree>;
}

/** Arguments given to the command {@linkcode openCommand}. */
interface OpenCommandArgs {
  readonly uri: string;
  /** 1-indexed line. */
  readonly line: number;
  /** 1-indexed column. */
  readonly column: number;
}
