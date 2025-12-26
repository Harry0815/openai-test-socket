import { Component } from '@angular/core';
import { AudioWidgetComponent } from './audio-widget/audio-widget.component';

@Component({
  standalone: true,
  imports: [AudioWidgetComponent],
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  title = 'angular-frontend';
}
