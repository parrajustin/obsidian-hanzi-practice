# Hanzi-Practice: Deep-Dive Replication Architecture

This document provides a line-level, highly specific blueprint for replicating the core logic engines of the Hanzi-Practice application. 

## 1. Spaced Repetition Engine (`spaced_repetition.ts`)
The application uses a heavily modified SuperMemo-2 algorithm.

### Core Mathematical Logic
The `SpacedRepetition` class calculates when a flashcard is due next by converting epoch timestamps to `TDayNumber`.
```typescript
// Base calculation for current day
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
Math.floor(Date.now() / DAY_IN_MILLISECONDS)
```

**The E-Factor & Interval Formula:**
When a card is graded (0-5), the algorithm calculates `dueDayNumber`:
1. If the score is `< 3` (Failing) or there are no previous reviews, `dueDayNumber = today` (or `today - 1` for brand new cards), forcing immediate review.
2. If the score is `>= 3` (Passing):
   - **Review #1:** `dueDayNumber = lastReviewDay + 1`
   - **Review #2:** `dueDayNumber = lastReviewDay + 6`
   - **Review #3+:** Calculates an incrementing `efactor` by looping over *all past reviews*:
     ```typescript
     let efactor = 2.5;
     reviews.forEach((review) => {
       // The core SM-2 modifier formula
       efactor += +(0.1 - (5 - review.difficulty) * (0.08 + (5 - review.difficulty) * 0.02));
     });
     // Clamp minimum efactor
     if (efactor < 1.3) efactor = 1.3;
     
     // Linear growth interval calculation (Deviation from standard SM-2 exponential)
     dueDayNumber = lastReviewDay + Math.ceil(reviews.length * efactor);
     ```

## 2. Quiz State Machine & Grading (`quizzer.ts`, `quiz.ts`)
The grading algorithm strictly enforces both drawing accuracy and pinyin recall.

### Final Grading Math (`quizzer.ts`)
The system captures `strokeMistakes` from Hanzi Writer and computes `percentMistakes = strokeMistakes / totalStrokes`.

**Base Score Matrix (from percentMistakes):**
- `< 1e-6` (0 mistakes) = 5
- Exactly 1 stroke mistake = 4
- `< 0.25` (25% mistakes) = 3
- `< 0.5` (50% mistakes) = 2
- `< 0.75` (75% mistakes) = 1
- `>= 0.75` (75%+ mistakes) = 0

**Pinyin Penalty Ceiling:**
The multiple-choice Pinyin test generates `resultPinyin` (integer count of mistakes).
- If `resultPinyin > 1`: `maxDifficulty = 3`
- If `resultPinyin === 1`: `maxDifficulty = 4`
- If `resultPinyin === 0`: `maxDifficulty = 5`

**Final Calculation:** `finalDifficulty = Math.min(BaseScore, maxDifficulty)`

### The "Give Up" Tutorial Flow
The `quiz.ts` component uses an internal state machine (via `StateReducerController`) with strict transition boundaries:
1. **`StateQuiz`**: Normal drawing mode (`HanziWriter` outline hidden).
2. **`StateGiveUpInform`**: User hits "Give up!". `HanziWriter` outline shown. A loop generates a visual "fanning" guide by injecting 75x75 SVG blocks, slicing the stroke array sequentially (`strokes.slice(0, i + 1)`).
3. **`StateGiveUpPractice`**: User practices tracing the outline. On complete, it calculates `percentMistakes`. 
   - **Rejection Loop:** If `percentMistakes > 0.25`, the state machine forces the user *back* to `StateGiveUpInform` via `ActionGaveUpPracticeFailed`. They cannot escape without > 75% accuracy.

### Pinyin Tone Selector (`pinyin_selector.ts`)
The multiple-choice Pinyin quiz uses a dynamic tone selector to test user recall.
1. **Distractor Generation**: It calls `ConstructOtherOptions(pinyin)` (from `prettify_pinyin.ts`) to programmatically generate 4 incorrect distractors (the same syllable but with different tone marks).
2. **Shuffle**: It combines the correct pinyin with the distractors and shuffles them in-place using a standard Fisher-Yates algorithm.
3. **Validation & Penalty**: When a user clicks an option:
   - If incorrect, a `5px solid red` outline is applied to the button, a `wrongGuesses` counter increments, and an error toast is shown.
   - If correct, it dispatches an `onComplete` event containing the final `mistakes` count (`wrongGuesses`), which is then caught by `quizzer.ts` to compute the "Pinyin Penalty Ceiling".

## 3. CC-CEDICT Tokenizer & MaxMatch (`cedict.ts`, `chinse_tokenizer.ts`)
To process Chinese input without spaces, the app utilizes a Dictionary Trie and a greedy Maximum Matching algorithm.

### Dictionary Parsing
The raw CC-CEDICT file is parsed line-by-line using this exact Regular Expression:
```typescript
const match = line.match(/^(\S+)\s(\S+)\s\[([^\]]+)\]\s\/(.+)\//);
// Groups: 1=Traditional, 2=Simplified, 3=Pinyin, 4=English Definition
```
The data is inserted into two `Trie` structures (`traditional_` and `simplified_`). 

### The MaxMatch Algorithm
The tokenizer iterates an index `i` through the input text.
1. **Multi-Character Attempt**: It slices the next 2 characters `processedText.slice(i, i + 2)`. It queries `CHINSE_DICTIONARY.getAllValuesForKeyAndDecendents(getTwo)`.
2. **Greedy Selection**: It iterates all descendants returned by the Trie to find the longest possible string that perfectly matches a subset of the input text starting at `i`.
   ```typescript
   // Pseudo-logic for the greedy grab
   if (matchText === word && word.length > longestFoundWord.length) {
       longestFoundWord = word;
   }
   ```
3. **Single Character Fallback**: If no multi-character match is found, it checks if `processedText[i]` is Chinese (exists in dictionary or matches hardcoded punctuation array).
4. **Pointer Incrementing**: Depending on the match, `i` increments by the byte length of the matched word, skipping past the processed chunk.

## 4. Tone Parsing & Unicode Shifting (`prettify_pinyin.ts`)
The logic programmatically converts standard numerical pinyin input into proper accented unicode text. This process is fully deterministic and requires no external libraries.

### Algorithm & Expected Output
**Input**: A numerical pinyin string (e.g., `"shi4"`, `"jia1"`).
**Expected Output**: The accurately toned string (e.g., `"shì"`, `"jiā"`).

**Step-by-step Execution**:
1. **Extraction**: Split the input into individual syllables. For each syllable, extract the last character, which represents the tone number (1-5).
2. **Vowel Iteration**: Iterate forward through the characters of the syllable, looking for a valid vowel (`a, e, i, o, u, ü`).
3. **Medial Vowel Rules**: If a vowel is found, the system checks for a "medial vowel collision". In Chinese orthography, medials (`i`, `u`, `ü`) never take the tone mark if they are immediately followed by another vowel. 
   - *Example*: For input `"jia1"`, the loop finds the first vowel `i`. It sees the next character is `a`. Because `i` is a medial and `a` is a vowel, the logic shifts the target character to `a`.
4. **Replacement Mapping**: The logic references a static map that pairs every base vowel to an array of its 4 possible toned unicode variants. It uses the extracted tone number as an array index to grab the specific unicode character.
   - *Example*: Target character `a`, tone `1` maps to the 0th index of `["ā", "á", "ǎ", "à"]`, retrieving `"ā"`.
5. **String Reassembly**: The target character in the syllable is replaced with the unicode character, the trailing number is sliced off, and the syllables are joined back together.

## 5. State Management & Batching (`state.ts`, `state_reducer.ts`)
The app uses a custom reactive architecture relying on `immer` and JavaScript microtasks.

### Microtask Batching
In `StateController`, state mutations are wrapped in `immer`'s `produce`. To prevent UI thrashing when multiple state changes occur in a single tick, it uses a boolean gate:
```typescript
if (!this.hasMicroTask_) {
  this.hasMicroTask_ = true;
  queueMicrotask(async () => {
    this.hasMicroTask_ = false;
    // Broadcast Immutable state to all LitElement listeners
    for (const cb of this.callbacks_) cb(this.current_);
  });
}
```

## 6. Error Handling Monads (`option.ts`, `result.ts`)
The app shuns `try/catch` and `null` in favor of Rust-like `Option<T>` and `Result<T,E>` interfaces.

### `Result<T, E>`
Returns either `OkImpl<T>` or `ErrImpl<E>`.
Crucially, `ErrImpl` captures the runtime stack at instantiation to prevent async stack loss:
```typescript
class ErrImpl<E> {
  public stack: string;
  constructor(public val: E) {
    this.stack = new Error().stack || "";
  }
}
```
This forces the TypeScript compiler to ensure the developer handles both the success data and the specific error string via `.andThen()` chaining.
