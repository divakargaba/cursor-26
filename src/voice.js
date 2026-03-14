// src/voice.js — Voice input: Web Speech API primary, Whisper API fallback
// Loaded in renderer via <script> tag

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

    this._initWebSpeech();
  }

  _initWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this.useFallback = true;
      return;
    }

    const rec = new SR();
    rec.continuous = false;
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
      if (interim) this.onInterim(interim);
      if (final) {
        this.onResult(final.trim());
        this._cleanup();
      }
    };

    rec.onerror = (e) => {
      if (e.error === 'not-allowed') {
        this.onError('Mic permission denied');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.useFallback = true;
        this.onError('Speech API unavailable, switching to Whisper');
      }
      this._cleanup();
    };

    rec.onend = () => {
      if (this.isListening) {
        // Recognition ended without a final result (e.g. silence timeout)
        this._cleanup();
      }
    };

    this.recognition = rec;
  }

  async start() {
    if (this.isListening) return;
    this.isListening = true;
    this.onStart();

    if (this.useFallback) {
      await this._startWhisper();
    } else {
      try {
        this.recognition.start();
      } catch (e) {
        this.useFallback = true;
        await this._startWhisper();
      }
    }
  }

  stop() {
    if (!this.isListening) return;

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // Stopping MediaRecorder triggers onstop → transcription → onResult
      this.mediaRecorder.stop();
    } else if (this.recognition) {
      try { this.recognition.stop(); } catch (e) { /* ignore */ }
    }

    this._cleanup();
  }

  toggle() {
    this.isListening ? this.stop() : this.start();
  }

  _cleanup() {
    this.isListening = false;
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
        if (this.audioChunks.length === 0) return;

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
