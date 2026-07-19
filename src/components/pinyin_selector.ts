import { ConstructOtherOptions, prettifyPinyin } from '../utils/prettify_pinyin';

export class PinyinSelector {
    private container: HTMLElement;
    private correctPinyin: string;
    private onComplete: (mistakes: number) => void;
    private mistakes = 0;
    private buttons: HTMLButtonElement[] = [];
    private completed = false;

    constructor(container: HTMLElement, correctPinyin: string, onComplete: (mistakes: number) => void) {
        this.container = container;
        this.correctPinyin = correctPinyin;
        this.onComplete = onComplete;
    }

    render() {
        this.container.empty();
        this.container.createEl('span', { text: 'Select Tone: ' });
        
        const correctFormatted = prettifyPinyin(this.correctPinyin);
        const distractors = ConstructOtherOptions(this.correctPinyin);
        
        const allOptions = [correctFormatted, ...distractors];
        
        // Fisher-Yates shuffle
        for (let i = allOptions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allOptions[i], allOptions[j]] = [allOptions[j], allOptions[i]];
        }
        
        const btnContainer = this.container.createDiv({ cls: 'pinyin-btn-container' });
        btnContainer.style.display = 'inline-flex';
        btnContainer.style.gap = '8px';
        btnContainer.style.flexWrap = 'wrap';
        btnContainer.style.marginLeft = '10px';

        for (const option of allOptions) {
            const btn = btnContainer.createEl('button', { text: option });
            this.buttons.push(btn);
            
            btn.onclick = () => {
                if (this.completed) return; // Prevent clicking after correct guess
                
                if (option === correctFormatted) {
                    btn.style.backgroundColor = '#4caf50'; // Green for correct
                    btn.style.color = 'white';
                    this.completed = true;
                    // Disable all buttons
                    this.buttons.forEach(b => {
                        b.disabled = true;
                        if (b !== btn) b.style.opacity = '0.5';
                    });
                    this.onComplete(this.mistakes);
                } else {
                    btn.style.border = '5px solid red'; // Penalty outline (per architecture spec)
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                    this.mistakes++;
                }
            };
        }
    }
}
