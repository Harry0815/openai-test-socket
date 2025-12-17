import { FastifyReply } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { Controller, Get, Res } from '@nestjs/common';

/**
 * Simple controller to serve static development files that live under src/.
 *
 * This is a minimal approach (no fastify-static plugin) that reads the file
 * from disk and returns it as text/html. It is intended for development/testing
 * convenience (e.g. serving `testAudio.html`).
 */
@Controller()
export class StaticController {
  @Get('test-client.html')
  serveTestAudio(@Res() res: FastifyReply) {
    const filePath = path.resolve(process.cwd(), 'apps/test-socket/src/assets/test-client.html');
    console.log('Served test-client.html:', filePath);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.type('text/html').send(content);
    } catch (error) {
      console.error('Failed to serve test-client.html:', error);
      res.status(404).send('Not found');
    }
  }

  @Get('voice-recording.html')
  serveVoiceRecording(@Res() res: FastifyReply) {
    const filePath = path.resolve(process.cwd(), 'apps/test-socket/src/assets/voice-recording.html');
    console.log('Served voice-recording.html:', filePath);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.type('text/html').send(content);
    } catch (error) {
      console.error('Failed to serve voice-recording.html:', error);
      res.status(404).send('Not found');
    }
  }

  @Get('live-audio-echo-client.html')
  serveLiveAudioEchoClient(@Res() res: FastifyReply) {
    const filePath = path.resolve(process.cwd(), 'apps/test-socket/src/assets/live-audio-echo-client.html');
    console.log('Served live-audio-echo-client.html:', filePath);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.type('text/html').send(content);
    } catch (error) {
      console.error('Failed to serve live-audio-echo-client.html:', error);
      res.status(404).send('Not found');
    }
  }

  @Get('audio-worklet.js')
  serveAudioWorklet(@Res() res: FastifyReply) {
    const filePath = path.resolve(process.cwd(), 'apps/test-socket/src/assets/audio-worklet.js');
    console.log('Served audio-worklet.js', filePath);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.type('application/javascript').send(content);
    } catch (error) {
      console.error('Failed to serve audio-worklet.js', error);
      res.status(404).send('Not found');
    }
  }
}
