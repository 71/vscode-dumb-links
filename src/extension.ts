import * as vscode from "vscode";

/**
 * ID of the command used to open a document via {@linkcode vscode.window.showTextDocument()}
 * when its URI does not support specific ranges.
 */
let openCommand: string;

export function activate(context: vscode.ExtensionContext) {
  openCommand = `${context.extension.id}.openAtRange`;

  const diagnosticsCollection = vscode.languages.createDiagnosticCollection(
    context.extension.id,
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider({ pattern: "**/*" }, {
      async provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
      ): Promise<vscode.DocumentLink[] | undefined> {
        const documentUriString = document.uri.toString();
        const resolver = new LinkResolver(documentUriString, token);

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

export function deactivate() {
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
    `(?<path>(?:${pathSegment.source})?(?:/${pathSegment.source})+)`,
  );

  // Matches `line` or `line:column`.
  const lineColumn = /(?<line>\d+)(?::(?<column>\d+))?/;

  // Matches a symbol.
  const symbolPath = /(?<symbol>[\w!?$@~.-]+)/;

  // Matches a text fragment; see
  // https://developer.mozilla.org/docs/Web/URI/Reference/Fragment/Text_fragments#syntax.
  const textFragment = /:~:text=(?<fragment>\S+)/;

  return new RegExp(
    `${prefix.source}${path.source}(?::${lineColumn.source}|#(?:${textFragment.source}|${symbolPath.source})?)?`,
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
        if (matchCache.target instanceof vscode.Diagnostic) {
          this.diagnostics.push(matchCache.target);
        } else {
          this.links.push(new vscode.DocumentLink(range, matchCache.target));
        }
        matchCache.keep = true;
        continue;
      }

      // Parse reference.
      const { path, line, column, symbol, fragment } = match.groups!;
      let targetUri: vscode.Uri;

      if (path.startsWith("/")) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (workspaceFolder === undefined) {
          this.diagnostics.push(
            new vscode.Diagnostic(
              range,
              `Cannot use absolute link \`${path}\` outside of a workspace.`,
              vscode.DiagnosticSeverity.Error,
            ),
          );
          continue;
        }

        targetUri = vscode.Uri.joinPath(workspaceFolder.uri, path.slice(1));
      } else {
        targetUri = vscode.Uri.joinPath(document.uri, "..", path);
      }
      const targetString = targetUri.toString();

      if (line !== undefined) {
        // Handle `:<line>` syntax.
        this.links.push(
          new vscode.DocumentLink(range, at(targetUri, +line, +(column ?? 1))),
        );
        continue;
      }

      let target: string | TextFragment;

      if (symbol !== undefined) {
        // Handle `#<symbol>` syntax.
        target = trimSuffix(symbol);
      } else if (fragment !== undefined) {
        // Handle `#:~:text=<fragment>` syntax.
        const parsed = parseTextFragment(trimSuffix(fragment));

        if (typeof parsed === "string") {
          const diagnosticEnd = match.index + matchText.length;
          const diagnosticStart = diagnosticEnd - fragment.length + 1; // Skip "#".

          this.diagnostics.push(
            new vscode.Diagnostic(
              new vscode.Range(
                new vscode.Position(lineNumber, diagnosticStart),
                new vscode.Position(lineNumber, diagnosticEnd),
              ),
              parsed,
              vscode.DiagnosticSeverity.Warning,
            ),
          );

          continue;
        }

        target = parsed;
      } else {
        // Plain link.
        this.links.push(new vscode.DocumentLink(range, targetUri));
        continue;
      }

      getOrCreate(this.referencedDocuments, targetString, () => ({
        uri: targetUri,
        references: [],
      })).references.push({ range, target, text: matchText });
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
    const withTextFragments: Reference[] = [];

    for (const reference of references) {
      if (typeof reference.target === "object") {
        withTextFragments.push(reference);
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
      ).references.push(reference);
    }

    const promises: Promise<void>[] = [];

    if (symbolTree.size > 0) {
      promises.push(this.resolveSymbols(uri, symbolTree, referenceCache));
    }
    if (withTextFragments.length > 0) {
      promises.push(
        this.resolveTextFragments(uri, withTextFragments, referenceCache),
      );
    }

    await Promise.all(promises);
  }

  // -----------------------------------------------------------------------------------------------
  // MARK: TextFragment resolution

  private async resolveTextFragments(
    uri: vscode.Uri,
    references: readonly Reference[],
    referenceCache: Map<string, Set<string>>,
  ): Promise<void> {
    // Read file, prioritizing the one currently loaded by VS Code.
    const document = vscode.workspace.textDocuments.find((document) =>
      uriEq(document.uri, uri)
    );
    let documentText = document?.getText();

    if (documentText === undefined) {
      try {
        const documentBytes = await vscode.workspace.fs.readFile(uri);

        documentText = await vscode.workspace.decode(documentBytes, { uri });
      } catch (e) {
        const message = `Cannot read \`${uri.toString(true)}\`: ${
          (e as Error).message
        }.`;

        for (const reference of references) {
          this.diagnostics.push(
            new vscode.Diagnostic(
              reference.range,
              message,
              vscode.DiagnosticSeverity.Error,
            ),
          );
        }

        return;
      }
    }

    // Compile text fragments into one `RegExp`. In theory we could just use `indexOf()` with each
    // fragment, but we need to be case-insensitive, so `indexOf()` would require us to copy the
    // document text with `toLowerCase()`. To avoid this, we can convert each fragment into a
    // `RegExp` with `i` flag. But we can do even better: we can put all the fragments into a single
    // `RegExp` and search all of them at once.
    const remainingFragments = references.map((reference) => {
      const fragment = reference.target as TextFragment;
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
          this.diagnostics.push(
            new vscode.Diagnostic(
              reference.range,
              `Cannot find \`${reference.text}\` in \`${uri.toString(true)}\`.`,
              vscode.DiagnosticSeverity.Warning,
            ),
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
    this.diagnoseMissing(symbolTree);
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

  private diagnoseMissing(tree: ReadonlyMap<string, SymbolTree>): void {
    for (const [_, node] of tree) {
      for (const reference of node.references) {
        const diagnostic = new vscode.Diagnostic(
          reference.range,
          `Unresolved reference: \`${reference.target}\`.`,
        );

        this.diagnostics.push(diagnostic);
        this.cachedDocument.references.set(reference.text, {
          target: diagnostic,
          keep: true,
        });
      }

      this.diagnoseMissing(node.children);
    }
  }

  private addLink(
    reference: Reference,
    target: vscode.Uri,
    targetLine: number,
    targetColumn: number,
    referenceCache: Map<string, Set<string>>,
  ): void {
    const link = new vscode.DocumentLink(
      reference.range,
      at(target, targetLine + 1, targetColumn + 1),
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
    return "Too many parts (separated by `-`) in text fragment.";
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

interface Reference {
  /** Range in the _referencing document_ (*not* the referenced document) where the reference is. */
  readonly range: vscode.Range;
  /** Text of the reference; used for caching. */
  readonly text: string;
  /** The target symbol path or text fragment. */
  readonly target: string | TextFragment;
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
      readonly target: vscode.Uri | vscode.Diagnostic;
      /** Set to false when loading the cache, and to true when the cache is used. */
      keep: boolean;
    }
  >;
}

/** A recursive tree of symbols. */
interface SymbolTree {
  /** References to that symbol. */
  readonly references: Reference[];
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
