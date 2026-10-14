// Turns raw terminal output into a readable text log: escape sequences are dropped and
// backspace, carriage return and erase-line are applied, so each saved line reads the way
// it looked on screen (a corrected typo is logged as the final command, not "sh ipp\b \b").
export class SessionLog {
  constructor(stream) {
    this.stream = stream;
    this.line = []; this.col = 0;
    this.state = 0; this.params = ''; // 0 text, 1 after ESC, 2 CSI, 3 OSC/DCS string, 4 ESC inside string, 5 one-char tail
  }

  // Start from the line the cursor is on, so the current prompt is not lost.
  seed(text = '', col = text.length) {
    this.line = Array.from(text); this.col = Math.min(col, this.line.length);
  }

  write(s) {
    for (const ch of s) {
      switch (this.state) {
        case 1:
          if (ch === '[') { this.state = 2; this.params = ''; }
          else if (']P_^X'.includes(ch)) this.state = 3;
          else this.state = '()#%'.includes(ch) ? 5 : 0;
          continue;
        case 2:
          if (ch >= '@' && ch <= '~') { this.csi(ch, this.params); this.state = 0; } else this.params += ch;
          continue;
        case 3: if (ch === '\x07') this.state = 0; else if (ch === '\x1b') this.state = 4; continue;
        case 4: this.state = ch === '\\' ? 0 : 3; continue;
        case 5: this.state = 0; continue;
      }
      if (ch === '\x1b') this.state = 1;
      else if (ch === '\n') this.flush();
      else if (ch === '\r') this.col = 0;
      else if (ch === '\b') this.col = Math.max(0, this.col - 1);
      else if (ch === '\t' || (ch >= ' ' && ch !== '\x7f')) this.line[this.col++] = ch;
    }
  }

  csi(final, params) {
    const n = parseInt(params, 10);
    if (final === 'K') {
      if (!n) this.line.length = Math.min(this.line.length, this.col);   // erase to end of line
      else if (n === 2) this.line = [];                                  // erase whole line
      else for (let i = 0; i < this.col; i++) this.line[i] = ' ';        // erase to start
    } else if (final === 'D') this.col = Math.max(0, this.col - (n || 1));
    else if (final === 'C') this.col += n || 1;
    else if (final === 'G') this.col = Math.max(0, (n || 1) - 1);
  }

  flush() {
    this.stream.write(Array.from(this.line, (c) => c ?? ' ').join('').trimEnd() + '\n');
    this.line = []; this.col = 0;
  }

  // Forget the unfinished current line (usually the prompt) instead of writing it.
  discardLine() { this.line = []; this.col = 0; }

  // Write any partial last line (usually the prompt) plus a footer, then close the file.
  end(footer, cb) {
    if (this.line.length) this.flush();
    this.stream.end(footer, cb);
  }
}
