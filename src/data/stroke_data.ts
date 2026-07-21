import {App} from 'obsidian';
import {gunzip} from '../utils/gunzip';
import {
  FileUtil,
  FileSystemType,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Ok, Err, Result} from 'standard-ts-lib/src/result';
import {StatusError, ErrorCode} from 'standard-ts-lib/src/status_error';
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
  try {
    const fileResult = await FileUtil.fetchFile(
      app,
      dataPath,
      FileSystemType.RAW,
    );
    if (!fileResult.ok) {
      return Err(
        new StatusError(
          ErrorCode.INTERNAL,
          `Failed to load stroke data: ${fileResult.val.message}`,
        ),
      );
    }
    let bytes: Uint8Array = fileResult.val;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      // Web-standard DecompressionStream (NOT Node zlib) — works on mobile.
      bytes = await gunzip(bytes);
    }
    return Ok(new StrokeDataReader(bytes));
  } catch (e) {
    return Err(
      new StatusError(
        ErrorCode.INTERNAL,
        `Error loading stroke data: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}
