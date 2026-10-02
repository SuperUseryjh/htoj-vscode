/**
 * 最小 vscode API stub。
 * 测试通过 test/setup.ts 里的 mock.module("vscode", ...) 把真实的 vscode 模块替换成它，
 * 这样就能在 bun test 里直接跑 provider / session 的逻辑。
 */

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class EventEmitter<T = void> {
  private listeners = new Set<(e: T) => void>();
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(data?: T): void {
    for (const listener of [...this.listeners]) {
      listener(data as T);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: unknown,
  ) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class MarkdownString {
  constructor(public value = "") {}
}

export class TreeItem {
  label?: string;
  description?: string;
  iconPath?: unknown;
  tooltip?: unknown;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {
    this.label = label;
  }
}

const settings: Record<string, unknown> = {
  zone: "cpp",
  pageSize: 20,
  defaultLanguage: "C++17 With O2",
  codeDirectory: "htoj",
  pollIntervalMs: 2000,
  pollTimeoutMs: 60000,
};

export const workspace = {
  getConfiguration(_section: string) {
    return {
      get<T>(key: string): T | undefined {
        return settings[key] as T | undefined;
      },
      update: async () => undefined,
    };
  },
  workspaceFolders: undefined as unknown,
  fs: {
    stat: async () => {
      throw new Error("stub: 未实现 fs.stat");
    },
    createDirectory: async () => undefined,
    writeFile: async () => undefined,
    readFile: async () => new Uint8Array(),
    readDirectory: async () => [],
  },
  openTextDocument: async () => {
    throw new Error("stub: 未实现 openTextDocument");
  },
};

export const commands = {
  executeCommand: async (_id: string, ..._args: unknown[]) => undefined,
};

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  createTreeView: () => ({ dispose: () => undefined }),
  // 测试里静默输出通道，避免日志污染断言输出
  createOutputChannel: (name: string) => ({
    name,
    appendLine: (_line: string) => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  createWebviewPanel: () => {
    throw new Error("stub: 未实现 createWebviewPanel");
  },
  createStatusBarItem: () => ({
    show: () => undefined,
    dispose: () => undefined,
    text: "",
    tooltip: "",
  }),
  withProgress: async (_options: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
    task({ report: () => undefined }, { isCancellationRequested: false }),
  onDidChangeActiveTextEditor: () => ({ dispose: () => undefined }),
  setStatusBarMessage: () => ({ dispose: () => undefined }),
};

export const ProgressLocation = { Notification: 15, SourceControl: 1, Window: 10 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ViewColumn = { Active: -1 };
export const ConfigurationTarget = { Global: 1, Workspace: 2 };
export const FileType = { File: 1, Directory: 2 };
export const env = { openExternal: async () => true };

export class Uri {
  constructor(public readonly value: string) {}
  static parse(value: string): Uri {
    return new Uri(value);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri([base.value, ...parts].join("/"));
  }
  toString(): string {
    return this.value;
  }
}

export interface SecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 内存版 SecretStorage，供测试使用 */
export class MemorySecretStorage implements SecretStorage {
  private values = new Map<string, string>();

  /**
   * vscode.SecretStorage 要求的事件。
   * 签名对齐 Event<SecretStorageChangeEvent>，否则 Session 的构造签名不兼容；
   * 测试里不需要真正触发，返回一个空的 disposable 即可。
   */
  readonly onDidChange = (
    _listener: (event: { key: string }) => unknown,
  ): { dispose(): void } => ({
    dispose: () => undefined,
  });

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
}
