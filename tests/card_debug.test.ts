import {cardTypeName, describeEntry} from '../src/telemetry/card_debug';
import {CardType, HANZI_BANK, PracticeEntry} from '../src/utils/practice_list';

describe('cardTypeName', () => {
  it('names every card type', () => {
    expect(cardTypeName(CardType.HANZI)).toBe('HANZI');
    expect(cardTypeName(CardType.FLASHCARD)).toBe('FLASHCARD');
    expect(cardTypeName(CardType.REVERSIBLE_FLASHCARD)).toBe(
      'REVERSIBLE_FLASHCARD',
    );
    expect(cardTypeName(CardType.MULTIPLE_CHOICE)).toBe('MULTIPLE_CHOICE');
    expect(cardTypeName(CardType.CLOZE)).toBe('CLOZE');
    expect(cardTypeName(CardType.TRUE_FALSE)).toBe('TRUE_FALSE');
  });

  it('treats a missing card type as hanzi (the legacy default)', () => {
    expect(cardTypeName(undefined)).toBe('HANZI');
  });

  it('labels an unknown numeric type instead of returning undefined', () => {
    expect(cardTypeName(99)).toBe('UNKNOWN(99)');
  });
});

describe('describeEntry', () => {
  it('describes a null entry', () => {
    expect(describeEntry(null)).toEqual({card: null});
  });

  it('describes a hanzi card with its character, pinyin and meaning', () => {
    const entry: PracticeEntry = {
      id: 'a1b2c3d4',
      cardType: CardType.HANZI,
      bank: HANZI_BANK,
      character: '好',
      pinyin: 'hao3',
      english: 'good',
    };
    expect(describeEntry(entry)).toEqual({
      id: 'a1b2c3d4',
      cardType: 0,
      cardTypeName: 'HANZI',
      bank: 'Hanzi',
      hasExplanation: false,
      character: '好',
      pinyin: 'hao3',
      english: 'good',
    });
  });

  it('flags a reversible flashcard so a wrong-side report is diagnosable', () => {
    const entry: PracticeEntry = {
      id: 'ffff0000',
      cardType: CardType.REVERSIBLE_FLASHCARD,
      bank: 'German',
      front: 'dog',
      back: 'Hund',
    };
    const described = describeEntry(entry);
    expect(described['reversible']).toBe(true);
    expect(described['front']).toBe('dog');
    expect(described['back']).toBe('Hund');
    expect(described['cardTypeName']).toBe('REVERSIBLE_FLASHCARD');
  });

  it('counts multiple-choice distractors rather than dumping them', () => {
    const entry: PracticeEntry = {
      id: 'aaaa1111',
      cardType: CardType.MULTIPLE_CHOICE,
      bank: 'Capitals',
      question: 'Capital of France?',
      answer: 'Paris',
      distractors: ['Lyon', 'Nice', 'Metz'],
    };
    const described = describeEntry(entry);
    expect(described['distractorCount']).toBe(3);
    expect(described['answer']).toBe('Paris');
  });

  it('reports the cloze text and hint', () => {
    const entry: PracticeEntry = {
      id: 'bbbb2222',
      cardType: CardType.CLOZE,
      bank: 'German',
      text: '我一个星期{{没}}吃饭。',
      hint: "I haven't eaten for a week.",
    };
    const described = describeEntry(entry);
    expect(described['text']).toBe('我一个星期{{没}}吃饭。');
    expect(described['hint']).toBe("I haven't eaten for a week.");
  });

  it('reports the true/false verdict', () => {
    const entry: PracticeEntry = {
      id: 'cccc3333',
      cardType: CardType.TRUE_FALSE,
      bank: 'Grammar',
      statement: '你有没有一只狗吗？',
      isCorrect: false,
      explanation: '有没有 already forms the question.',
    };
    const described = describeEntry(entry);
    expect(described['isCorrect']).toBe(false);
    expect(described['hasExplanation']).toBe(true);
  });

  it('truncates long free text so one card cannot flood the log', () => {
    const entry: PracticeEntry = {
      id: 'dddd4444',
      cardType: CardType.FLASHCARD,
      bank: 'Long',
      front: 'x'.repeat(200),
      back: 'y',
    };
    const front = String(describeEntry(entry)['front']);
    expect(front.length).toBeLessThan(70);
    expect(front.endsWith('…')).toBe(true);
  });
});
