import { EventEmitter } from 'events';
import { screen, Display } from 'electron';

export class DisplayDetectorService extends EventEmitter {
  private listening = false;
  private onAdded = (_event: Electron.Event, display: Display) => {
    const count = screen.getAllDisplays().length;
    console.log(`External display connected (${count} displays, id=${display.id})`);
    this.emit('display-connected', { count, display });
  };
  private onRemoved = (_event: Electron.Event, display: Display) => {
    const count = screen.getAllDisplays().length;
    console.log(`External display disconnected (${count} displays, id=${display.id})`);
    this.emit('display-disconnected', { count, display });
  };

  start(): void {
    if (this.listening) return;
    this.listening = true;
    screen.on('display-added', this.onAdded);
    screen.on('display-removed', this.onRemoved);
    console.log(`Display detector started (${screen.getAllDisplays().length} display(s))`);
  }

  stop(): void {
    if (!this.listening) return;
    screen.removeListener('display-added', this.onAdded);
    screen.removeListener('display-removed', this.onRemoved);
    this.listening = false;
    console.log('Display detector stopped');
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.listening) {
      this.start();
    } else if (!enabled && this.listening) {
      this.stop();
    }
  }
}
