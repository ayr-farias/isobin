import fs from 'node:fs';
export declare function removeEmptyDirs(dir: string): void;
/**
 * Copies a cached file to `destination`, giving the copy the source file's
 * access and modification times so restored output reflects when it was cached.
 */
export declare function copyCachedFile(source: fs.PathLike, destination: fs.PathLike): Promise<void>;
export declare function emptyDir(_dir: URL, skip?: Set<string>): void;
