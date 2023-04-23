import { posix } from "../deps/path.ts";

import type { Data } from "./filesystem.ts";

type EntryType = "file" | "directory";

export interface Options {
  root: string;
  ignore?: (string | ((entry: Entry) => boolean))[];
}

export type Loader = (path: string) => Promise<Data>;

export class Entry {
  name: string;
  path: string;
  type: EntryType;
  src: string;
  children = new Map<string, Entry>();
  flags = new Set<string>();
  #content = new Map<Loader, Promise<Data> | Data>();
  #info?: Deno.FileInfo;

  constructor(name: string, path: string, type: EntryType, src: string) {
    this.name = name;
    this.path = path;
    this.type = type;
    this.src = src;
  }

  removeCache() {
    this.#content.clear();
    this.#info = undefined;
  }

  getContent(loader: Loader): Promise<Data> | Data {
    if (!this.#content.has(loader)) {
      this.#content.set(loader, loader(this.src));
    }

    return this.#content.get(loader)!;
  }

  setContent(loader: Loader, content: Data) {
    this.#content.set(loader, content);
  }

  getInfo() {
    if (!this.#info) {
      this.#info = this.src.includes("://")
        ? createFileInfo(this.type)
        : Deno.statSync(this.src);
    }

    return this.#info;
  }
}

/** Virtual file system used to load and cache files (local and remote) */
export default class FS {
  options: Options;
  entries = new Map<string, Entry>();
  remoteFiles = new Map<string, string>();
  tree: Entry;

  constructor(options: Options) {
    this.options = options;
    this.tree = new Entry("", "/", "directory", options.root);
    this.entries.set("/", this.tree);
  }

  init() {
    this.#walkFs(this.tree);
    this.#walkRemote();
  }

  normalize(path: string) {
    path = posix.join("/", path);
    return path.endsWith("/") ? path.slice(0, -1) : path;
  }

  update(path: string): Entry {
    const entry = this.entries.get(path) ||
      this.addEntry({ path, type: "file" });
    entry.removeCache();

    // Remove if it doesn't exist
    try {
      entry.getInfo();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        this.removeEntry(entry);
      }
    }

    return entry;
  }

  #isValid(entry: Entry) {
    const { ignore } = this.options;

    return ignore
      ? !ignore.some((ignore) =>
        typeof ignore === "string"
          ? (entry.path.startsWith(posix.join(ignore, "/")) ||
            entry.path === ignore)
          : ignore(entry)
      )
      : true;
  }

  #walkFs(dir: Entry) {
    const prefix = dir.path === "/" ? "" : dir.path;
    const dirPath = `${this.options.root}${prefix}`;

    for (const dirEntry of Deno.readDirSync(dirPath)) {
      if (dirEntry.isSymlink) {
        continue;
      }

      const path = `${prefix}/${dirEntry.name}`;
      const entry = new Entry(
        dirEntry.name,
        path,
        dirEntry.isDirectory ? "directory" : "file",
        this.options.root + path,
      );

      if (!this.#isValid(entry)) {
        continue;
      }

      dir.children.set(dirEntry.name, entry);
      this.entries.set(path, entry);

      if (entry.type === "directory") {
        this.#walkFs(entry);
      }
    }
  }

  #walkRemote() {
    // Read from remote files
    for (const [path, src] of this.remoteFiles) {
      if (this.entries.has(path)) {
        continue;
      }

      this.addEntry({
        path,
        type: "file",
        src,
      }).flags.add("remote");
    }
  }

  addEntry(data: { path: string; type: EntryType; src?: string }): Entry {
    const pieces = data.path.split("/").filter((p) => p);
    let parent = this.tree;

    while (pieces.length > 1) {
      const name = pieces.shift()!;
      const children = parent.children;
      const prefix = parent.path === "/" ? "" : parent.path;
      const path = `${prefix}/${name}`;

      parent = children.get(name) || new Entry(
        name,
        path,
        "directory",
        this.options.root + path,
      );

      if (!this.#isValid(parent)) {
        break;
      }

      children.set(name, parent);
      this.entries.set(parent.path, parent);
    }

    const name = pieces.shift()!;
    const children = parent.children;
    const entry = new Entry(
      name,
      data.path,
      data.type,
      data.src || this.options.root + data.path,
    );
    children.set(name, entry);
    this.entries.set(entry.path, entry);
    return entry;
  }

  removeEntry(entry: Entry) {
    this.entries.delete(entry.path);
    const parent = this.entries.get(posix.dirname(entry.path))!;
    parent.children.delete(entry.name);
  }
}

function createFileInfo(type: EntryType): Deno.FileInfo {
  return {
    isFile: type === "file",
    isDirectory: type === "directory",
    isSymlink: false,
    size: 0,
    mtime: new Date(),
    atime: new Date(),
    birthtime: new Date(),
    dev: 0,
    ino: null,
    mode: null,
    nlink: null,
    uid: null,
    gid: null,
    rdev: null,
    blksize: null,
    blocks: null,
  };
}
