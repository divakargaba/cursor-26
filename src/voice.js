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
