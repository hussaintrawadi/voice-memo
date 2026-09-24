-- Loudest moment of the recording (0-1), measured on the device. Near-zero means silence,
-- which Whisper would otherwise "transcribe" into invented phrases.
ALTER TABLE recordings ADD COLUMN audio_peak REAL;
