import { prettifyPinyin, ConstructOtherOptions } from './src/utils/prettify_pinyin';

const tests = ['shi4', 'jia1', 'lüe4', 'huang2', 'nv3', 'nu3', 'er2', 'ma', 'shuo1', 'que4'];

for (const t of tests) {
    console.log(`${t} -> ${prettifyPinyin(t)}`);
    console.log(`  Options: ${ConstructOtherOptions(t).join(', ')}`);
}
