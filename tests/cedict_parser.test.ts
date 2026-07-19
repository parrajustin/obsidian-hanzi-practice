import {CedictParser} from '../src/dictionary/cedict_parser';

describe('CedictParser & MaxMatch', () => {
  let parser: CedictParser;

  beforeEach(() => {
    parser = new CedictParser();
    // Simulate parsing the dictionary
    const mockDictText = `
測試 测试 [ce4 shi4] /test/
漢 汉 [han4] /Chinese/
語 语 [yu3] /language/
漢語 汉语 [han4 yu3] /Chinese language/
`;
    parser.parse(mockDictText);
  });

  it('should parse dictionary lines correctly', () => {
    const searchResult = parser.simplifiedTrie.search('汉语');
    expect(searchResult).toBeDefined();

    if (searchResult) {
      const entry = JSON.parse(searchResult[0]);
      expect(entry.pinyin).toBe('han4 yu3');
      expect(entry.english).toBe('Chinese language');
    }
  });

  it('should tokenize greedy MaxMatch properly', () => {
    // text: "我学习汉语测试"
    // "我", "学", "习" are unknown, "汉语", "测试" are known
    const tokens = parser.tokenize('我学习汉语测试');
    expect(tokens).toEqual(['我', '学', '习', '汉语', '测试']);
  });

  it('should correctly prioritize longer matches', () => {
    // "汉" and "语" exist individually, but "汉语" exists and is longer
    const tokens = parser.tokenize('汉语');
    expect(tokens).toEqual(['汉语']); // Instead of ['汉', '语']
  });
});
