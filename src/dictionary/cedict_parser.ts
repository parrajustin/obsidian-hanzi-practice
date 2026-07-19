import { App } from 'obsidian';
import * as zlib from 'zlib';
import { FileUtil, FileSystemType } from 'standard-obsidian-lib/src/filesystem/file_util';
import { Trie } from './trie';
import { Ok, Err, Result } from 'standard-ts-lib/src/result';
import { StatusError, ErrorCode } from 'standard-ts-lib/src/status_error';

export interface CedictEntry {
  traditional: string;
  simplified: string;
  pinyin: string;
  english: string;
}

export class CedictParser {
  simplifiedTrie = new Trie();
  traditionalTrie = new Trie();

  async loadDictionary(app: App, dictPath: string): Promise<Result<boolean, StatusError>> {
    // Determine if it's raw or obsidian vault path. For now, assume obsidian vault path
    // Wait, the prompt says the file is in: /home/jrparra/git/obsidian-hanzi-practice/cedict_1_0_...
    // If it's in the plugin root, we can fetch it via adapter (RAW).
    
    try {
      const fileResult = await FileUtil.fetchFile(app, dictPath, FileSystemType.RAW);
      if (!fileResult.ok) {
        return Err(new StatusError(ErrorCode.INTERNAL, `Failed to load dict: ${fileResult.val.message}`));
      }

      // The dictionary ships gzipped (`.txt.gz`) to keep the plugin download
      // small. Detect the gzip magic bytes (0x1f 0x8b) and inflate; otherwise
      // treat the bytes as plain UTF-8 text.
      const bytes = fileResult.val;
      let text: string;
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        text = zlib.gunzipSync(Buffer.from(bytes)).toString('utf-8');
      } else {
        text = new TextDecoder('utf-8').decode(bytes);
      }

      this.parse(text);
      return Ok(true);
    } catch (e: any) {
      return Err(new StatusError(ErrorCode.INTERNAL, `Error loading dict: ${e.message}`));
    }
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

        const jsonStr = JSON.stringify({ traditional, simplified, pinyin, english });
        
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
      let longestMatch = '';
      
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
