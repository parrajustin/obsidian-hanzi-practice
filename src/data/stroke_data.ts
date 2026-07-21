import {App} from 'obsidian';
import {gunzip} from '../utils/gunzip';
import {
  FileUtil,
  FileSystemType,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Result} from 'standard-ts-lib/src/result';
import {StatusError} from 'standard-ts-lib/src/status_error';
import {InjectStatusMsg} from 'standard-ts-lib/src/status_util/inject_status_msg';
import {StrokeDataReader} from './stroke_codec';

/**
 * Loads the shipped stroke database (`hanzi-strokes.bin.gz`, generated at build
 * time from hanzi-writer-data) from the plugin folder. Mirrors the CEDICT
 * pattern: fetch raw bytes, gunzip if the gzip magic is present, then hand the
 * blob to the random-access `StrokeDataReader` (per-character decode on
 * demand — the full database is never expanded into JS objects).
 */
export async function loadStrokeData(
  app: App,
  dataPath: string,
): Promise<Result<StrokeDataReader, StatusError>> {
  const fileResult = await FileUtil.fetchFile(
    app,
    dataPath,
    FileSystemType.RAW,
  );
  if (fileResult.err) {
    return fileResult.mapErr(e =>
      e.with(InjectStatusMsg('Failed to load stroke data')),
    );
  }
  let bytes: Uint8Array = fileResult.safeUnwrap();
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    // Web-standard DecompressionStream (NOT Node zlib) — works on mobile.
    const inflated = await gunzip(bytes);
    if (inflated.err) {
      return inflated.mapErr(e =>
        e.with(InjectStatusMsg('Failed to load stroke data')),
      );
    }
    bytes = inflated.safeUnwrap();
  }
  return StrokeDataReader.create(bytes).mapErr(e =>
    e.with(InjectStatusMsg('Failed to load stroke data')),
  );
}
