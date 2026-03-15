// src/voice.js — Voice input: Web Speech API primary, Whisper API fallback
// Loaded in renderer via <script> tag
//
// Web Speech API is unreliable in Electron (especially macOS) — it often fires
// onend prematurely without a final result. We detect this and auto-switch to
// Whisper fallback. Whisper requires OPENAI_API_KEY in .env.

class VoiceInput {
  constructor({ onResult, onInterim, onStart, onStop, onError } = {}) {
    this.onResult = onResult || (() => {});
    this.onInterim = onInterim || (() => {});
    this.onStart = onStart || (() => {});
    this.onStop = onStop || (() => {});
    this.onError = onError || (() => {});

    this.isListening = false;
    this.recognition = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.useFallback = false;
    this._gotFinalResult = false;
    this._lastInterim = '';
    this._stoppedByUser = false;

    this._initWebSpeech();
  }

  _initWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.log('[voice] No SpeechRecognition API — using Whisper fallback');
      this.useFallback = true;
      return;
    }

    const rec = new SR();
    rec.continuous = true;       // Keep listening until user stops
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onresult = (e) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      if (interim) {
        this._lastInterim = interim;
        this.onInterim(interim);
      }
      if (final) {
        this._gotFinalResult = true;
        this._lastInterim = '';
        this.onResult(final.trim());
        this._cleanup();
      }
    };

    rec.onerror = (e) => {
      console.log('[voice] SpeechRecognition error:', e.error);
      if (e.error === 'not-allowed') {
        this.onError('Mic permission denied');
        this._cleanup();
      } else if (e.error === 'no-speech') {
        // Silence timeout — not an error, just stop
        this._cleanup();
      } else if (e.error !== 'aborted') {
        // Other errors — switch to Whisper
        console.log('[voice] Switching to Whisper fallback');
        this.useFallback = true;
        this.onError('Speech API unavailable, switching to Whisper');
        this._cleanup();
      }
    };

    rec.onend = () => {
      if (!this.isListening) return;
      if (this._gotFinalResult) return; // Already handled in onresult

      if (this._stoppedByUser) {
        // User pressed stop — use whatever interim we have
        if (this._lastInterim.trim()) {
          this.onResult(this._lastInterim.trim());
        }
        this._cleanup();
      } else {
        // Recognition ended unexpectedly (Electron bug) — restart it
        console.log('[voice] SpeechRecognition ended unexpectedly, restarting...');
        try {
          rec.start();
        } catch (e) {
          // Can't restart — switch to Whisper for this session
          console.log('[voice] Could not restart SpeechRecognition, switching to Whisper');
          this.useFallback = true;
          this._cleanup();
          this.onError('Speech recognition unstable — using Whisper next time. Try again.');
        }
      }
    };

    this.recognition = rec;
  }

  async start() {
    if (this.isListening) return;
    this.isListening = true;
    this._gotFinalResult = false;
    this._lastInterim = '';
    this._stoppedByUser = false;
    this.onStart();

    if (this.useFallback) {
      await this._startWhisper();
    } else {
      try {
        this.recognition.start();
      } catch (e) {
        console.log('[voice] SpeechRecognition.start() failed:', e.message);
        this.useFallback = true;
        await this._startWhisper();
      }
    }
  }

  stop() {
    if (!this.isListening) return;
    this._stoppedByUser = true;

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // Stopping MediaRecorder triggers onstop → transcription → onResult
      this.mediaRecorder.stop();
      // _cleanup will be called after transcription completes
    } else if (this.recognition) {
      try { this.recognition.stop(); } catch (e) { /* ignore */ }
      // onend handler will fire → sees _stoppedByUser → sends interim → _cleanup
    } else {
      this._cleanup();
    }
  }

  toggle() {
    this.isListening ? this.stop() : this.start();
  }

  _cleanup() {
    if (!this.isListening) return; // Prevent double cleanup
    this.isListening = false;
    this._lastInterim = '';
    this.onStop();
  }

  async _startWhisper() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(stream);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (this.audioChunks.length === 0) {
          this._cleanup();
          return;
        }

        const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
        const base64 = await this._blobToBase64(blob);

        try {
          const result = await window.aiAssistant.transcribeAudio(base64);
          if (result.ok && result.text) {
            this.onResult(result.text.trim());
          } else {
            this.onError(result.error || 'Transcription failed');
          }
        } catch (e) {
          this.onError('Transcription error');
        }
        this._cleanup();
      };

      this.mediaRecorder.start();
    } catch (e) {
      this.onError('Mic access denied');
      this._cleanup();
    }
  }

  _blobToBase64(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(blob);
    });
  }
}

// =============================================================================
// Always-On Wake Word Listener — "Hey Jarvis" activation
// Uses Web Speech API in continuous mode to detect "Jarvis" wake word.
// When detected, extracts the command (if any) and fires callback.
// =============================================================================

class AlwaysOnListener {
  constructor({ onWakeWord, onActiveStart, onActiveEnd, onError, onDeactivate, onAbort } = {}) {
    this.onWakeWord = onWakeWord || (() => {});
    this.onActiveStart = onActiveStart || (() => {});
    this.onActiveEnd = onActiveEnd || (() => {});
    this.onError = onError || (() => {});
    this.onDeactivate = onDeactivate || (() => {});
    this.onAbort = onAbort || (() => {});

    this.enabled = false;
    this._processingCommand = false;
    this._whisperStream = null;
    this._audioContext = null;
    this._analyser = null;
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this._processingCommand = false;
    this._startWhisperLoop();
  }

  // =========================================================================
  // Whisper continuous listening — fallback when Web Speech unavailable
  // Records short audio segments, uses voice activity detection (VAD) to
  // only transcribe when someone is speaking. Checks for "Jarvis" wake word.
  // =========================================================================

  async _startWhisperLoop() {
    if (!this.enabled) this.enabled = true;

    try {
      this._whisperStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      this.onError('Mic access denied');
      this.enabled = false;
      return;
    }

    // Set up AudioContext for silence detection during recording
    this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (this._audioContext.state === 'suspended') {
      await this._audioContext.resume();
    }
    const source = this._audioContext.createMediaStreamSource(this._whisperStream);
    this._analyser = this._audioContext.createAnalyser();
    this._analyser.fftSize = 512;
    source.connect(this._analyser);

    // Keepalive: force-resume AudioContext every 2s (Chromium suspends on inactive windows)
    this._keepaliveInterval = setInterval(() => {
      if (this._audioContext && this._audioContext.state === 'suspended') {
        this._audioContext.resume();
      }
    }, 2000);

    // Also resume immediately on state change
    this._audioContext.onstatechange = () => {
      if (this._audioContext && this._audioContext.state === 'suspended') {
        this._audioContext.resume();
      }
    };

    // Expose for main process keepalive
    window._alwaysOnAudioCtx = this._audioContext;

    console.log(`[always-on] Wake word listener active (Whisper, AudioContext: ${this._audioContext.state})`);
    this._whisperCycle();
  }

  async _whisperCycle() {
    if (!this.enabled) return;
    if (this._processingCommand) {
      setTimeout(() => this._whisperCycle(), 500);
      return;
    }

    // Record a segment — always record, let Whisper decide if there's speech
    try {
      const audioBase64 = await this._recordUntilSilence();
      if (!audioBase64 || !this.enabled) {
        setTimeout(() => this._whisperCycle(), 100);
        return;
      }

      // Transcribe via Whisper — start next listen cycle IMMEDIATELY
      // so we don't miss speech during transcription
      this._transcribeAndCheck(audioBase64);
    } catch (e) {
      console.log('[always-on] Cycle error:', e.message);
    }

    // Restart cycle right away — don't wait for transcription
    if (this.enabled) {
      setTimeout(() => this._whisperCycle(), 100);
    }
  }

  async _transcribeAndCheck(audioBase64) {
    try {
      const result = await window.aiAssistant.transcribeAudio(audioBase64);
      if (result.ok && result.text) {
        const transcript = result.text.trim();
        if (!this._isHallucination(transcript)) {
          console.log(`[always-on] Heard: "${transcript}"`);
          this._checkWakeWord(transcript, true);
        }
      } else if (!result.ok) {
        console.log(`[always-on] Whisper error: ${result.error}`);
      }
    } catch (e) {
      console.log('[always-on] Transcribe error:', e.message);
    }
  }

  async _detectSpeech() {
    if (!this._analyser) return true;
    // Resume AudioContext if Chromium suspended it (window inactive)
    if (this._audioContext && this._audioContext.state === 'suspended') {
      await this._audioContext.resume();
    }
    const data = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length;
    return avg > 8;
  }

  /**
   * Record audio until the speaker pauses (1.5s of silence).
   * Max recording: 15 seconds (safety cap).
   * Returns base64 audio or null.
   */
  _recordUntilSilence() {
    return new Promise((resolve) => {
      if (!this._whisperStream || !this._analyser) { resolve(null); return; }
      const chunks = [];
      let recorder;
      try {
        recorder = new MediaRecorder(this._whisperStream);
      } catch (e) { resolve(null); return; }

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        if (chunks.length === 0) { resolve(null); return; }
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      };

      recorder.start();

      const SILENCE_THRESHOLD = 1500; // 1.5s of silence = end of utterance
      const MAX_DURATION = 15000;     // 15s safety cap
      const CHECK_INTERVAL = 100;     // check every 100ms
      let silentSince = 0;
      let started = Date.now();

      const checkSilence = () => {
        if (recorder.state === 'inactive') return;

        // Keep AudioContext alive
        if (this._audioContext && this._audioContext.state === 'suspended') {
          this._audioContext.resume();
        }

        const elapsed = Date.now() - started;

        // Safety cap
        if (elapsed > MAX_DURATION) {
          recorder.stop();
          return;
        }

        // Check audio level
        const data = new Uint8Array(this._analyser.frequencyBinCount);
        this._analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;

        if (avg < 10) {
          // Silence
          if (silentSince === 0) silentSince = Date.now();
          else if (Date.now() - silentSince > SILENCE_THRESHOLD && elapsed > 3000) {
            // Been silent for 1.5s and we have at least 3s of audio
            recorder.stop();
            return;
          }
        } else {
          // Speech — reset silence timer
          silentSince = 0;
        }

        setTimeout(checkSilence, CHECK_INTERVAL);
      };

      setTimeout(checkSilence, CHECK_INTERVAL);
    });
  }

  /**
   * Filter common Whisper hallucinations on silence/noise.
   * Returns true if the transcript is likely hallucinated garbage.
   */
  _isHallucination(text) {
    if (!text || text.length < 2) return true;
    const lower = text.toLowerCase();
    // Common Whisper silence hallucinations
    const hallucinations = [
      'thank you for watching', 'thanks for watching',
      'subscribe', 'like and subscribe', 'see you next time',
      'bye bye', 'thank you',
    ];
    if (hallucinations.includes(lower.replace(/[.!,]/g, '').trim())) return true;
    // Non-latin scripts (Whisper hallucinates CJK/emoji on noise)
    if (/[^\x00-\x7F]/.test(text) && !lower.includes('jarvis')) return true;
    // Very short non-wake-word utterances
    if (text.length < 4 && !lower.includes('jarvis')) return true;
    return false;
  }

  // =========================================================================
  // Wake word detection
  // =========================================================================

  _checkWakeWord(transcript, isFinal) {
    const lower = transcript.toLowerCase();
    const wakeIdx = lower.indexOf('jarvis');
    if (wakeIdx === -1) return;

    const afterWake = transcript.slice(wakeIdx + 6).replace(/^[,.\s]+/, '').trim();
    const afterLower = afterWake.toLowerCase();

    // Abort commands always get through, even mid-execution
    const abortPatterns = /^(stop|cancel|abort|never\s?mind|hold on|wait)$/i;
    if (isFinal && abortPatterns.test(afterLower)) {
      console.log('[always-on] Abort command detected');
      this._processingCommand = false;
      this.onAbort();
      return;
    }

    // Deactivation commands always get through
    const deactivatePatterns = /^(deactivate|stop listening|go to sleep|shut down|goodbye|good night|sleep)$/i;
    if (isFinal && deactivatePatterns.test(afterLower)) {
      console.log('[always-on] Deactivation command detected');
      this._processingCommand = false;
      this.onDeactivate();
      return;
    }

    if (this._processingCommand) return;

    if (isFinal) {
      this._processingCommand = true;
      this.onActiveStart();

      if (afterWake) {
        console.log(`[always-on] Wake word + command: "${afterWake}"`);
        this.onWakeWord(afterWake);
        setTimeout(() => {
          this._processingCommand = false;
          this.onActiveEnd();
        }, 2000);
      } else {
        console.log('[always-on] Wake word detected, waiting for command...');
        this.onWakeWord(null);
        setTimeout(() => {
          this._processingCommand = false;
          this.onActiveEnd();
        }, 1000);
      }
    } else {
      // Interim — visual feedback
      this.onActiveStart();
    }
  }

  stop() {
    this.enabled = false;
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
    if (this._whisperStream) {
      this._whisperStream.getTracks().forEach(t => t.stop());
      this._whisperStream = null;
    }
    if (this._audioContext) {
      this._audioContext.onstatechange = null;
      this._audioContext.close().catch(() => {});
      this._audioContext = null;
      this._analyser = null;
    }
    window._alwaysOnAudioCtx = null;
    console.log('[always-on] Wake word listener stopped');
  }

  toggle() {
    this.enabled ? this.stop() : this.start();
    return this.enabled;
  }

  resume() {
    this._processingCommand = false;
  }
}
