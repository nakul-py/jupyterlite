export const DIR_MODE = 16895; // 040777
export const FILE_MODE = 33206; // 100666
export const SEEK_CUR = 1;
export const SEEK_END = 2;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

// Mapping flag -> do we need to overwrite the file upon closing it
const flagNeedsWrite: { [flag: number]: boolean } = {
  0 /*O_RDONLY*/: false,
  1 /*O_WRONLY*/: true,
  2 /*O_RDWR*/: true,
  64 /*O_CREAT*/: true,
  65 /*O_WRONLY|O_CREAT*/: true,
  66 /*O_RDWR|O_CREAT*/: true,
  129 /*O_WRONLY|O_EXCL*/: true,
  193 /*O_WRONLY|O_CREAT|O_EXCL*/: true,
  514 /*O_RDWR|O_TRUNC*/: true,
  577 /*O_WRONLY|O_CREAT|O_TRUNC*/: true,
  578 /*O_CREAT|O_RDWR|O_TRUNC*/: true,
  705 /*O_WRONLY|O_CREAT|O_EXCL|O_TRUNC*/: true,
  706 /*O_RDWR|O_CREAT|O_EXCL|O_TRUNC*/: true,
  1024 /*O_APPEND*/: true,
  1025 /*O_WRONLY|O_APPEND*/: true,
  1026 /*O_RDWR|O_APPEND*/: true,
  1089 /*O_WRONLY|O_CREAT|O_APPEND*/: true,
  1090 /*O_RDWR|O_CREAT|O_APPEND*/: true,
  1153 /*O_WRONLY|O_EXCL|O_APPEND*/: true,
  1154 /*O_RDWR|O_EXCL|O_APPEND*/: true,
  1217 /*O_WRONLY|O_CREAT|O_EXCL|O_APPEND*/: true,
  1218 /*O_RDWR|O_CREAT|O_EXCL|O_APPEND*/: true,
  4096 /*O_RDONLY|O_DSYNC*/: true,
  4098 /*O_RDWR|O_DSYNC*/: true,
};

// Types and implementation inspired from
// https://github.com/jvilk/BrowserFS
// https://github.com/jvilk/BrowserFS/blob/a96aa2d417995dac7d376987839bc4e95e218e06/src/generic/emscripten_fs.ts
// And from https://github.com/gzuidhof/starboard-notebook
export interface IStats {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  timestamp?: number;
}

export interface IEmscriptenFSNode {
  name: string;
  mode: number;
  parent: IEmscriptenFSNode;
  mount: { opts: { root: string } };
  stream_ops: IEmscriptenStreamOps;
  node_ops: IEmscriptenNodeOps;
  timestamp: number;
}

export interface IEmscriptenStream {
  node: IEmscriptenFSNode;
  nfd: any;
  flags: string;
  position: number;
  file?: DriveFS.IFile;
}

export interface IEmscriptenNodeOps {
  getattr(node: IEmscriptenFSNode): IStats;
  setattr(node: IEmscriptenFSNode, attr: IStats): void;
  lookup(parent: IEmscriptenFSNode, name: string): IEmscriptenFSNode;
  mknod(
    parent: IEmscriptenFSNode,
    name: string,
    mode: number,
    dev: any
  ): IEmscriptenFSNode;
  rename(oldNode: IEmscriptenFSNode, newDir: IEmscriptenFSNode, newName: string): void;
  unlink(parent: IEmscriptenFSNode, name: string): void;
  rmdir(parent: IEmscriptenFSNode, name: string): void;
  readdir(node: IEmscriptenFSNode): string[];
  symlink(parent: IEmscriptenFSNode, newName: string, oldPath: string): void;
  readlink(node: IEmscriptenFSNode): string;
}

export interface IEmscriptenStreamOps {
  open(stream: IEmscriptenStream): void;
  close(stream: IEmscriptenStream): void;
  read(
    stream: IEmscriptenStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number;
  write(
    stream: IEmscriptenStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number;
  llseek(stream: IEmscriptenStream, offset: number, whence: number): number;
}

export class DriveFSEmscriptenStreamOps implements IEmscriptenStreamOps {
  private fs: DriveFS;

  constructor(fs: DriveFS) {
    this.fs = fs;
  }

  public open(stream: IEmscriptenStream): void {
    const path = this.fs.realPath(stream.node);
    if (this.fs.FS.isFile(stream.node.mode)) {
      stream.file = this.fs.API.get(path);
    }
  }

  public close(stream: IEmscriptenStream): void {
    if (!this.fs.FS.isFile(stream.node.mode) || !stream.file) {
      return;
    }

    const path = this.fs.realPath(stream.node);

    const flags = stream.flags;
    let parsedFlags = typeof flags === 'string' ? parseInt(flags, 10) : flags;
    parsedFlags &= 0x1fff;

    let needsWrite = true;
    if (parsedFlags in flagNeedsWrite) {
      needsWrite = flagNeedsWrite[parsedFlags];
    }

    if (needsWrite) {
      this.fs.API.put(path, stream.file);
      stream.file = undefined;
    }
  }

  public read(
    stream: IEmscriptenStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number {
    if (length <= 0 || stream.file === undefined) {
      return 0;
    }

    const size = Math.min((stream.file.data.length ?? 0) - position, length);
    try {
      buffer.set(stream.file.data.subarray(position, position + size), offset);
    } catch (e) {
      throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES['EPERM']);
    }
    return size;
  }

  public write(
    stream: IEmscriptenStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number {
    if (length <= 0 || stream.file === undefined) {
      return 0;
    }

    stream.node.timestamp = Date.now();

    try {
      if (position + length > (stream.file?.data.length ?? 0)) {
        const oldData = stream.file.data ? stream.file.data : new Uint8Array();
        stream.file.data = new Uint8Array(position + length);
        stream.file.data.set(oldData);
      }

      stream.file.data.set(buffer.subarray(offset, offset + length), position);

      return length;
    } catch (e) {
      throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES['EPERM']);
    }
  }

  public llseek(stream: IEmscriptenStream, offset: number, whence: number): number {
    let position = offset;
    if (whence === SEEK_CUR) {
      position += stream.position;
    } else if (whence === SEEK_END) {
      if (this.fs.FS.isFile(stream.node.mode)) {
        try {
          position += stream.file!.data.length;
        } catch (e) {
          throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES['EPERM']);
        }
      }
    }

    if (position < 0) {
      throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES['EINVAL']);
    }

    return position;
  }
}

export class DriveFSEmscriptenNodeOps implements IEmscriptenNodeOps {
  private fs: DriveFS;

  constructor(fs: DriveFS) {
    this.fs = fs;
  }

  public getattr(node: IEmscriptenFSNode): IStats {
    return this.fs.API.getattr(this.fs.realPath(node));
  }

  public setattr(node: IEmscriptenFSNode, attr: IStats): void {
    // TODO
  }

  public lookup(parent: IEmscriptenFSNode, name: string): IEmscriptenFSNode {
    const path = this.fs.PATH.join2(this.fs.realPath(parent), name);
    console.log('trying a lookup on path', path);
    const result = this.fs.API.lookup(path);
    console.log('lookup', result);
    if (!result.ok) {
      throw this.fs.FS.genericErrors[this.fs.ERRNO_CODES['ENOENT']];
    }
    return this.fs.createNode(parent, name, result.mode);
  }

  public mknod(
    parent: IEmscriptenFSNode,
    name: string,
    mode: number,
    dev: any
  ): IEmscriptenFSNode {
    const path = this.fs.PATH.join2(this.fs.realPath(parent), name);
    this.fs.API.mknod(path, mode);
    return this.fs.createNode(parent, name, mode, dev);
  }

  public rename(
    oldNode: IEmscriptenFSNode,
    newDir: IEmscriptenFSNode,
    newName: string
  ): void {
    this.fs.API.rename(
      oldNode.parent
        ? this.fs.PATH.join2(this.fs.realPath(oldNode.parent), oldNode.name)
        : oldNode.name,
      this.fs.PATH.join2(this.fs.realPath(newDir), newName)
    );

    // Updating the in-memory node
    oldNode.name = newName;
    oldNode.parent = newDir;
  }

  public unlink(parent: IEmscriptenFSNode, name: string): void {
    this.fs.API.rmdir(this.fs.PATH.join2(this.fs.realPath(parent), name));
  }

  public rmdir(parent: IEmscriptenFSNode, name: string) {
    this.fs.API.rmdir(this.fs.PATH.join2(this.fs.realPath(parent), name));
  }

  public readdir(node: IEmscriptenFSNode): string[] {
    return this.fs.API.readdir(this.fs.realPath(node));
  }

  public symlink(parent: IEmscriptenFSNode, newName: string, oldPath: string): void {
    throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES['EPERM']);
  }

  public readlink(node: IEmscriptenFSNode): string {
    throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES['EPERM']);
  }
}

/**
 * Wrap serviceworker requests for an Emscripten-compatible syncronous API.
 */
export class ContentsAPI {
  constructor(baseUrl: string, FS: any, ERRNO_CODES: any) {
    this._baseUrl = baseUrl;
    this.FS = FS;
    this.ERRNO_CODES = ERRNO_CODES;
  }

  request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    data: string | null = null
  ): any {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `${this._baseUrl}api${path}`, false);

    try {
      if (data === null) {
        xhr.send();
      } else {
        xhr.send(data);
      }
    } catch (e) {
      console.error(e);
    }

    if (xhr.status >= 400) {
      throw new this.FS.ErrnoError(this.ERRNO_CODES['EINVAL']);
    }

    return JSON.parse(xhr.responseText);
  }

  lookup(path: string): DriveFS.ILookup {
    return this.request('GET', `${path}?m=lookup`);
  }

  getmode(path: string): number {
    return Number.parseInt(this.request('GET', `${path}?m=getmode`));
  }

  mknod(path: string, mode: number) {
    return this.request('GET', `${path}?m=mknod&args=${mode}`);
  }

  rename(oldPath: string, newPath: string): void {
    return this.request('GET', `${oldPath}?m=rename&args=${newPath}`);
  }

  readdir(path: string): string[] {
    const dirlist = this.request('GET', `${path}?m=readdir`);
    dirlist.push('.');
    dirlist.push('..');
    return dirlist;
  }

  rmdir(path: string): void {
    return this.request('GET', `${path}?m=rmdir`);
  }

  get(path: string): DriveFS.IFile {
    const response = this.request('GET', `${path}?m=get`);

    const serializedContent = response.content;
    const format: 'json' | 'text' | 'base64' | null = response.format;

    switch (format) {
      case 'json':
      case 'text':
        return {
          data: encoder.encode(serializedContent),
          format,
        };
      case 'base64': {
        const binString = atob(serializedContent);
        const len = binString.length;
        const data = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          data[i] = binString.charCodeAt(i);
        }
        return {
          data,
          format,
        };
      }
      default:
        throw new this.FS.ErrnoError(this.ERRNO_CODES['ENOENT']);
    }
  }

  put(path: string, value: DriveFS.IFile) {
    switch (value.format) {
      case 'json':
      case 'text':
        return this.request(
          'PUT',
          `${path}?m=put&args=${value.format}`,
          decoder.decode(value.data)
        );
      case 'base64': {
        let binary = '';
        for (let i = 0; i < value.data.byteLength; i++) {
          binary += String.fromCharCode(value.data[i]);
        }
        return this.request('PUT', `${path}?m=put&args=${value.format}`, btoa(binary));
      }
    }
  }

  getattr(path: string): IStats {
    const stats = this.request('GET', `${path}?m=getattr`);
    // Turn datetimes into proper objects
    stats.atime = new Date(stats.atime);
    stats.mtime = new Date(stats.mtime);
    stats.ctime = new Date(stats.ctime);
    return stats;
  }

  private _baseUrl: string;
  private FS: any;
  private ERRNO_CODES: any;
}

export class DriveFS {
  FS: any;
  API: ContentsAPI;
  PATH: DriveFS.IPath;
  ERRNO_CODES: any;

  constructor(options: DriveFS.IOptions) {
    this.FS = options.FS;
    this.PATH = options.PATH;
    this.ERRNO_CODES = options.ERRNO_CODES;
    this.API = new ContentsAPI(options.baseUrl, this.FS, this.ERRNO_CODES);

    this.node_ops = new DriveFSEmscriptenNodeOps(this);
    this.stream_ops = new DriveFSEmscriptenStreamOps(this);
  }

  node_ops: IEmscriptenNodeOps;
  stream_ops: IEmscriptenStreamOps;

  mount(mount: any): IEmscriptenFSNode {
    return this.createNode(null, mount.mountpoint, DIR_MODE | 511, 0);
  }

  createNode(
    parent: IEmscriptenFSNode | null,
    name: string,
    mode: number,
    dev?: any
  ): IEmscriptenFSNode {
    const FS = this.FS;
    if (!FS.isDir(mode) && !FS.isFile(mode)) {
      throw new FS.ErrnoError(this.ERRNO_CODES['EINVAL']);
    }
    const node = FS.createNode(parent, name, mode, dev);
    node.node_ops = this.node_ops;
    node.stream_ops = this.stream_ops;
    return node;
  }

  getMode(path: string): number {
    return this.API.getmode(path);
  }

  realPath(node: IEmscriptenFSNode): string {
    const parts: string[] = [];
    let currentNode: IEmscriptenFSNode = node;

    parts.push(currentNode.name);
    while (currentNode.parent !== currentNode) {
      currentNode = currentNode.parent;
      parts.push(currentNode.name);
    }
    parts.reverse();

    return this.PATH.join.apply(null, parts);
  }
}

/**
 * A namespace for DriveFS configurations, etc.
 */
export namespace DriveFS {
  /**
   * A file representation;
   */
  export interface IFile {
    data: Uint8Array;
    format: 'json' | 'text' | 'base64';
  }

  /**
   * The response to a lookup request;
   */
  export interface ILookup {
    ok: boolean;
    mode: number;
  }

  /**
   * The emscripten FS Path API;
   */
  export interface IPath {
    basename: (path: string) => string;
    dirname: (path: string) => string;
    join: (...parts: string[]) => string;
    join2: (l: string, r: string) => string;
    normalize: (path: string) => string;
    splitPath: (filename: string) => string;
  }

  /**
   * Initialization options for a drive;
   */
  export interface IOptions {
    FS: any;
    PATH: IPath;
    ERRNO_CODES: any;
    baseUrl: string;
  }
}
