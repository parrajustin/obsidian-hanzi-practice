import {App} from 'obsidian';
import {gunzip} from '../utils/gunzip';
import {
  FileUtil,
  FileSystemType,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Trie} from './trie';
import {Ok, Result} from 'standard-ts-lib/src/result';
import {StatusError} from 'standard-ts-lib/src/status_error';
import {InjectStatusMsg} from 'standard-ts-lib/src/status_util/inject_status_msg';

export interface CedictEntry {
  traditional: string;
  simplified: string;
  pinyin: string;
  english: string;
}

export class CedictParser {
  simplifiedTrie = new Trie();
  traditionalTrie = new Trie();

  async loadDictionary(
    app: App,
    dictPath: string,
  ): Promise<Result<boolean, StatusError>> {
    const fileResult = await FileUtil.fetchFile(
      app,
      dictPath,
      FileSystemType.RAW,
    );
    if (fileResult.err) {
      return fileResult.mapErr(e =>
        e.with(InjectStatusMsg('Failed to load dict')),
      );
    }

    // The dictionary ships gzipped (`.txt.gz`) to keep the plugin download
    // small. Detect the gzip magic bytes (0x1f 0x8b) and inflate; otherwise
    // treat the bytes as plain UTF-8 text. Inflation uses the web-standard
    // DecompressionStream (NOT Node zlib) so this also works on mobile.
    const bytes = fileResult.safeUnwrap();
    let text: string;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const inflated = await gunzip(bytes);
      if (inflated.err) {
        return inflated.mapErr(e =>
          e.with(InjectStatusMsg('Failed to load dict')),
        );
      }
      text = new TextDecoder('utf-8').decode(inflated.safeUnwrap());
    } else {
      text = new TextDecoder('utf-8').decode(bytes);
    }

    this.parse(text);
    return Ok(true);
  }

  parse(text: string) {
    const lines = text.split('\n');
    const regex = /^(\S+)\s(\S+)\s\[([^\]]+)\]\s\/(.+)\//;

    for (const line of lines) {
      if (line.startsWith('#') || !line.trim()) continue;

      const match = line.match(regex);
      if (match) {
        const traditional = match[1];
        const simplified = match[2];
        const pinyin = match[3];
        const english = match[4];

        const jsonStr = JSON.stringify({
          traditional,
          simplified,
          pinyin,
          english,
        });

        this.simplifiedTrie.insert(simplified, jsonStr);
        this.traditionalTrie.insert(traditional, jsonStr);
      }
    }
  }

  /**
   * MaxMatch Tokenizer
   */
  tokenize(text: string): string[] {
    const tokens: string[] = [];
    let i = 0;

    while (i < text.length) {
      // Try to match the longest possible string starting at i
      // We check substrings from i up to text.length
      let current = this.simplifiedTrie.root;
      let j = i;
      let lastMatchIndex = -1;

      while (j < text.length && current.children.has(text[j])) {
        current = current.children.get(text[j])!;
        if (current.isEndOfWord) {
          lastMatchIndex = j;
        }
        j++;
      }

      if (lastMatchIndex !== -1) {
        const match = text.substring(i, lastMatchIndex + 1);
        tokens.push(match);
        i = lastMatchIndex + 1;
      } else {
        // Fallback: single character
        tokens.push(text[i]);
        i++;
      }
    }

    return tokens;
  }
}
