import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

let configured = false;

export const ensureFfmpegConfigured = (): void => {
  if (configured) {
    return;
  }

  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  configured = true;
};
