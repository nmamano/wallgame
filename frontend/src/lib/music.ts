/**
 * MusicController manages background music playback during game sessions.
 *
 * Features:
 * - Sequential playlist with automatic track advancement
 * - Preloads next track for seamless transitions
 * - Reacts to musicEnabled policy changes
 * - Isolated error handling (failed tracks are skipped)
 * - Proper cleanup on teardown
 */

const PLAYLIST = [
  "/audio/songs/song1.mp3",
  "/audio/songs/song2.mp3",
  "/audio/songs/song3.mp3",
  "/audio/songs/song4.mp3",
];

const MUSIC_VOLUME = 0.3;

export class MusicController {
  private currentAudio: HTMLAudioElement | null = null;
  private nextAudio: HTMLAudioElement | null = null;
  private currentIndex: number;
  private isPlaying = false;
  private isTornDown = false;

  /**
   * Ref to musicEnabled for async callbacks (avoids stale closures).
   * This should be the same ref from the SoundProvider.
   */
  private musicEnabledRef: { current: boolean };

  constructor(musicEnabledRef: { current: boolean }) {
    this.musicEnabledRef = musicEnabledRef;
    // Randomize starting track - playlist cycles sequentially from here
    this.currentIndex = Math.floor(Math.random() * PLAYLIST.length);
  }

  /**
   * Start playing music if enabled.
   * Call this when the game screen mounts.
   */
  start(): void {
    if (this.isTornDown) return;
    if (!this.musicEnabledRef.current) return;

    this.isPlaying = true;
    this.playCurrentTrack();
  }

  /**
   * Called when musicEnabled policy changes.
   * Pauses immediately if disabled, resumes if enabled.
   */
  onPolicyChange(enabled: boolean): void {
    if (this.isTornDown) return;

    if (!enabled) {
      this.pause();
    } else if (!this.isPlaying) {
      this.isPlaying = true;
      this.playCurrentTrack();
    }
  }

  /**
   * Pause music playback.
   */
  pause(): void {
    this.isPlaying = false;
    if (this.currentAudio) {
      this.currentAudio.pause();
    }
  }

  /**
   * Resume music playback if it was paused.
   */
  resume(): void {
    if (this.isTornDown) return;
    if (!this.musicEnabledRef.current) return;

    this.isPlaying = true;
    if (this.currentAudio?.paused) {
      void this.currentAudio.play().catch(() => {
        // Audio play failed (likely autoplay policy), skip to next
        this.advanceTrack();
      });
    } else if (!this.currentAudio) {
      this.playCurrentTrack();
    }
  }

  /**
   * Clean up all audio elements and stop playback.
   * Call this when leaving the game screen.
   */
  teardown(): void {
    this.isTornDown = true;
    this.isPlaying = false;

    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = "";
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio = null;
    }

    if (this.nextAudio) {
      this.nextAudio.src = "";
      this.nextAudio.onended = null;
      this.nextAudio.onerror = null;
      this.nextAudio = null;
    }
  }

  private playCurrentTrack(): void {
    if (this.isTornDown) return;
    if (!this.isPlaying) return;

    const trackUrl = PLAYLIST[this.currentIndex];
    this.currentAudio = this.createAudioElement(trackUrl);

    this.currentAudio.onended = () => {
      this.advanceTrack();
    };

    this.currentAudio.onerror = () => {
      // Failed to load track, skip to next
      console.warn(`Music: Failed to load track ${trackUrl}, skipping`);
      this.advanceTrack();
    };

    void this.currentAudio.play().catch(() => {
      // Autoplay blocked - this is expected before user interaction
      // The track will start when user interacts with the page
      // We keep isPlaying=true so we can retry later
    });

    // Preload next track
    this.preloadNextTrack();
  }

  private preloadNextTrack(): void {
    if (this.isTornDown) return;

    const nextIndex = (this.currentIndex + 1) % PLAYLIST.length;
    const nextUrl = PLAYLIST[nextIndex];

    this.nextAudio = this.createAudioElement(nextUrl);
    // Just preload, don't play yet
    this.nextAudio.preload = "auto";
  }

  private advanceTrack(): void {
    if (this.isTornDown) return;
    if (!this.isPlaying) return;
    if (!this.musicEnabledRef.current) {
      this.pause();
      return;
    }

    // Clean up current
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = "";
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
    }

    // Advance index
    this.currentIndex = (this.currentIndex + 1) % PLAYLIST.length;

    // Use preloaded audio if available
    if (this.nextAudio) {
      this.currentAudio = this.nextAudio;
      this.nextAudio = null;

      this.currentAudio.onended = () => {
        this.advanceTrack();
      };

      this.currentAudio.onerror = () => {
        console.warn(
          `Music: Failed to play track ${PLAYLIST[this.currentIndex]}, skipping`,
        );
        this.advanceTrack();
      };

      void this.currentAudio.play().catch(() => {
        // Autoplay blocked, try next track
        this.advanceTrack();
      });

      // Preload the next one
      this.preloadNextTrack();
    } else {
      // No preloaded audio, create new
      this.playCurrentTrack();
    }
  }

  private createAudioElement(src: string): HTMLAudioElement {
    const audio = new Audio(src);
    audio.volume = MUSIC_VOLUME;
    audio.preload = "auto";
    return audio;
  }
}
