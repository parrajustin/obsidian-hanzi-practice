export const pinyinTones: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
  v: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

const vowels = new Set(['a', 'e', 'i', 'o', 'u', 'ü', 'v']);
const medials = new Set(['i', 'u', 'ü', 'v']);

export function prettifyPinyin(numericalPinyin: string): string {
  const syllables = numericalPinyin.split(' ');

  const prettified = syllables.map(syllable => {
    const lastChar = syllable.slice(-1);
    const tone = parseInt(lastChar);

    // If no tone number or tone 5 (neutral), just strip the number
    if (isNaN(tone) || tone < 1 || tone > 4) {
      return syllable.replace(/\d$/, '').replace(/v/g, 'ü');
    }

    const chars = syllable.slice(0, -1).split('');

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i].toLowerCase();

      if (vowels.has(char)) {
        let targetIndex = i;

        // Medial collision rule: if medial is immediately followed by another vowel, shift target
        if (
          medials.has(char) &&
          i + 1 < chars.length &&
          vowels.has(chars[i + 1].toLowerCase())
        ) {
          targetIndex = i + 1;
        }

        const targetChar = chars[targetIndex].toLowerCase();
        // Replace with toned version
        const tonedChar = pinyinTones[targetChar][tone - 1];

        // Preserve casing if needed
        const isUpper = chars[targetIndex] === chars[targetIndex].toUpperCase();
        chars[targetIndex] = isUpper ? tonedChar.toUpperCase() : tonedChar;

        break; // done with this syllable
      }
    }

    return chars.join('').replace(/v/g, 'ü');
  });

  return prettified.join(' ');
}

export function ConstructOtherOptions(pinyin: string): string[] {
  const lastChar = pinyin.slice(-1);
  const originalTone = parseInt(lastChar);

  if (isNaN(originalTone)) {
    return [];
  }

  const basePinyin = pinyin.slice(0, -1);
  const options: string[] = [];

  for (let i = 1; i <= 5; i++) {
    if (i !== originalTone) {
      options.push(prettifyPinyin(basePinyin + i));
    }
  }

  return options;
}
