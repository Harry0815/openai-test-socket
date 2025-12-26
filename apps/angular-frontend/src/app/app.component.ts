import { Component } from '@angular/core';
import { AudioWidgetComponent } from './audio-widget/audio-widget.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [AudioWidgetComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent {
  transportUrl = 'ws://localhost:3000';
}
