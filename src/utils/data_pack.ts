/**
 * A "data pack" is a small JSON file that links practice banks to the
 * markdown files holding their cards, so a whole set of banks can be
 * installed from Settings → "Import data pack" in one click instead of adding
 * each bank row by hand. The pack does NOT contain cards — the linked
 * markdown files do (see CARD_FORMATS.md for both formats).
 *
 * Shape (version 1):
 *
 *     {
 *       "version": 1,
 *       "name": "HSK 1 starter",            // optional display name
 *       "banks": [
 *         {"name": "Capitals", "filePath": "packs/capitals-cards.md"}
 *       ],
 *       "rules": …                          // reserved, ignored today
 *     }
 *
 * Importing merges the pack's banks into the configured bank list BY NAME:
 * unknown names append a bank, known names re-point that bank's file path.
 * The built-in "Hanzi" bank is never touched (its file is the top-level
 * `practiceFilePath` setting, not a `banks` entry).
 */

import {App} from 'obsidian';
import {
  FileSystemType,
  FileUtil,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {z} from 'zod';
import {Err, Ok, Result} from 'standard-ts-lib/src/result';
import {
  InvalidArgumentError,
  StatusError,
} from 'standard-ts-lib/src/status_error';
import {WrapToResult} from 'standard-ts-lib/src/wrap_to_result';
import {BankSource, HANZI_BANK} from './practice_list';

export const DATA_PACK_VERSION = 1;

const dataPackBankSchema = z.object({
  name: z.string().min(1),
  filePath: z.string().min(1),
});

const dataPackSchema = z.object({
  version: z.literal(DATA_PACK_VERSION),
  /** Optional display name, shown in the import confirmation Notice. */
  name: z.string().optional(),
  banks: z.array(dataPackBankSchema),
  // Reserved for future load-rules (filtering, scheduling overrides, …).
  // Parsed and ignored today so packs authored for a future version still
  // import their banks in this one.
  rules: z.unknown().optional(),
});

export type DataPackBank = z.infer<typeof dataPackBankSchema>;
export type DataPack = z.infer<typeof dataPackSchema>;

/** Parse + validate raw data-pack JSON text. */
export function parseDataPack(text: string): Result<DataPack, StatusError> {
  const parsed = WrapToResult(
    () => JSON.parse(text) as unknown,
    /*textForUnknown=*/ 'Data pack is not valid JSON',
  );
  if (!parsed.ok) {
    return parsed;
  }
  const validated = dataPackSchema.safeParse(parsed.val);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const at = issue.path.length > 0 ? ` at "${issue.path.join('.')}"` : '';
    return Err(
      InvalidArgumentError(`Invalid data pack${at}: ${issue.message}`),
    );
  }
  return Ok(validated.data);
}

/**
 * Read + parse a registered pack's JSON file from the vault. Packs are
 * registered by path (not copied into the settings), so every load sees the
 * file's CURRENT content — editing or syncing an updated pack JSON updates
 * the banks on the next plugin start / bank resolution.
 */
export async function loadDataPack(
  app: App,
  filePath: string,
): Promise<Result<DataPack, StatusError>> {
  const fileResult = await FileUtil.fetchFile(
    app,
    filePath,
    FileSystemType.OBSIDIAN,
  );
  if (!fileResult.ok) {
    return fileResult;
  }
  return parseDataPack(new TextDecoder('utf-8').decode(fileResult.val));
}

export interface DataPackMergeResult {
  /** The new bank list — the input list is never mutated. */
  banks: BankSource[];
  /** Pack banks whose name was not configured yet — appended. */
  added: number;
  /** Pack banks whose name existed with a different file path — re-pointed. */
  updated: number;
  /** Pack banks already configured with the same file path — no-ops. */
  unchanged: number;
  /** Pack banks named "Hanzi" — reserved for the built-in bank, never merged. */
  skipped: number;
}

/** Merge a pack's banks into the configured bank list by bank name. */
export function mergeDataPackBanks(
  existing: readonly BankSource[],
  pack: DataPack,
): DataPackMergeResult {
  const banks = existing.map(b => ({name: b.name, filePath: b.filePath}));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const packBank of pack.banks) {
    if (packBank.name === HANZI_BANK) {
      skipped++;
      continue;
    }
    const match = banks.find(b => b.name === packBank.name);
    if (!match) {
      banks.push({name: packBank.name, filePath: packBank.filePath});
      added++;
    } else if (match.filePath !== packBank.filePath) {
      match.filePath = packBank.filePath;
      updated++;
    } else {
      unchanged++;
    }
  }
  return {banks, added, updated, unchanged, skipped};
}
