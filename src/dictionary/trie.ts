export class TrieNode {
  children: Map<string, TrieNode> = new Map();
  isEndOfWord: boolean = false;
  definitions: string[] = []; // Can store multiple definitions for the same word
}

export class Trie {
  root: TrieNode = new TrieNode();

  insert(word: string, definition: string) {
    let current = this.root;
    for (const char of word) {
      if (!current.children.has(char)) {
        current.children.set(char, new TrieNode());
      }
      current = current.children.get(char)!;
    }
    current.isEndOfWord = true;
    current.definitions.push(definition);
  }

  search(word: string): string[] | null {
    let current = this.root;
    for (const char of word) {
      if (!current.children.has(char)) {
        return null;
      }
      current = current.children.get(char)!;
    }
    return current.isEndOfWord ? current.definitions : null;
  }
}
