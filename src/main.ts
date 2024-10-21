import {
  type App,
  type Editor,
  type MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  RequestUrlParam,
  Setting,
  TAbstractFile,
  TFile,
  normalizePath,
  requestUrl,
} from 'obsidian';
const { SmartChatModel } = require('smart-chat-model');

import { SmartMemosAudioRecordModal } from './SmartMemosAudioRecordModal'; // Update with the correct path
import { saveFile, readBinaryFile, createNewNote, insertLinkInEditor } from './Utils';

interface AudioPluginSettings {
  model: string;
  apiKey: string;
  prompt: string;
  includeTranscript: boolean;
  recordingFilePath: string;
  keepAudio: boolean;
  includeAudioFileLink: boolean;
}

const DEFAULT_SETTINGS: AudioPluginSettings = {
  model: 'gpt-4-0613',
  apiKey: '',
  prompt:
    'You are an expert note-making AI for obsidian who specializes in the Linking Your Thinking (LYK) strategy.  The following is a transcription of recording of someone talking aloud or people in a conversation. There may be a lot of random things said given fluidity of conversation or thought process and the microphone\'s ability to pick up all audio.  Give me detailed notes in markdown language on what was said in the most easy-to-understand, detailed, and conceptual format.  Include any helpful information that can conceptualize the notes further or enhance the ideas, and then summarize what was said.  Do not mention "the speaker" anywhere in your response.  The notes your write should be written as if I were writting them. Finally, ensure to end with code for a mermaid chart that shows an enlightening concept map combining both the transcription and the information you added to it.  The following is the transcribed audio:\n\n',
  includeTranscript: true,
  recordingFilePath: '',
  keepAudio: true,
  includeAudioFileLink: false,
};

const MODELS: string[] = [
  'gpt-3.5-turbo-16k',
  'gpt-3.5-turbo-0613',
  'text-davinci-003',
  'text-davinci-002',
  'code-davinci-002',
  'code-davinci-001',
  'gpt-4-0613',
  'gpt-4-32k-0613',
  'gpt-4o',
  'gpt-4o-mini',
];

export default class SmartMemosPlugin extends Plugin {
  settings: AudioPluginSettings;
  writing: boolean;
  transcript: string;
  apiKey = 'sk-as123mkqwenjasdasdj12...';
  model = 'gpt-4-0613';

  appJsonObj: any;

  private audioContext: AudioContext;

  // Add a new property to store the audio file
  audioFile: Blob;

  async onload() {
    await this.loadSettings();
    const app_json = await this.app.vault.adapter.read('.obsidian/app.json');
    this.appJsonObj = JSON.parse(app_json);

    this.audioContext = new (
      window.AudioContext || (window as any).webkitAudioContext
    )();

    this.addCommand({
      id: 'open-transcript-modal',
      name: 'Smart transcribe',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.commandGenerateTranscript(editor);
      },
    });

    this.addCommand({
      id: 'record-smart-memo',
      name: 'Record smart memo',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        // Open the audio recorder and store the recorded audio
        this.audioFile = await new SmartMemosAudioRecordModal(
          this.app,
          this.handleAudioRecording.bind(this),
          this.settings,
        ).open();
      },
    });

    this.registerMarkdownPostProcessor(
      (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        const audioLinks = el.querySelectorAll(
          'a.internal-link[data-href$=".wav"]',
        );
        audioLinks.forEach((link) => {
          const href = link.getAttribute('data-href');
          if (href === null) {
            console.error(
              'Failed to get the href attribute from the link element.',
            );
            return; // Skip this iteration because there's no href
          }

          const abstractFile = this.app.vault.getAbstractFileByPath(href);
          if (!(abstractFile instanceof TFile)) {
            console.error(
              'The path does not point to a valid file in the vault.',
            );
            return; // Skip this iteration because there's no file
          }

          const audio = document.createElement('audio');
          audio.src = this.app.vault.getResourcePath(abstractFile);
          audio.controls = true;
          audio.addEventListener('loadedmetadata', () => {
            if (audio.parentNode) {
              const durationDisplay = document.createElement('span');
              durationDisplay.textContent = `Duration: ${audio.duration.toFixed(2)} seconds`;
              audio.parentNode.insertBefore(durationDisplay, audio.nextSibling);
            }
          });
          audio.load(); // Trigger metadata loading
          link.replaceWith(audio); // Replace the link with the audio player
        });
      },
    );

    // Add the audio recorder ribbon
    // Update the callback for the audio recorder ribbon
    this.addRibbonIcon(
      'microphone',
      'Record smart memo',
      async (evt: MouseEvent) => {
        // Open the audio recorder and store the recorded audio
        this.audioFile = await new SmartMemosAudioRecordModal(
          this.app,
          this.handleAudioRecording.bind(this),
          this.settings,
        ).open();
      },
    );

    this.addSettingTab(new SmartMemosSettingTab(this.app, this));
  }

  // Add a new method to handle the audio recording and processing
  async handleAudioRecording(
    audioFile: Blob,
    transcribe: boolean,
    keepAudio: boolean,
    includeAudioFileLink: boolean,
  ) {
    try {
      console.log('Handling audio recording:', audioFile);

      if (!audioFile) {
        console.log('No audio was recorded.');
        return;
      }

      this.audioFile = audioFile;

      // Save the audio recording as a .wav file
      const fileName = `recording-${Date.now()}.wav`;
      const file = await saveFile(
        this.app,
        this.audioFile,
        fileName,
        this.settings.recordingFilePath,
      );

      this.settings.keepAudio = keepAudio;
      this.settings.includeAudioFileLink = includeAudioFileLink;
      this.saveSettings();

      // Insert a link to the audio file in the current note or create a new note if none is open
      let activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView) {
        // Create a new note if no active view
        const newFilePath = `${this.settings.recordingFilePath}/New Recording ${Date.now()}.md`;
        activeView = await createNewNote(this.app, newFilePath);
      }

      if (activeView) {
        insertLinkInEditor(activeView.editor, file.path);
      }

      // Transcribe the audio file if the transcribe parameter is true
      if (transcribe) {
        this.transcribeRecording(file);
      }
    } catch (error) {
      console.error('Error handling audio recording:', error);
      new Notice('Failed to handle audio recording');
    }
  }

  // Add a new method to transcribe the audio file and generate text
  async transcribeRecording(audioFile: TFile) {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      console.error('No active Markdown view found.');
      return;
    }

    const editor = activeView.editor;
    readBinaryFile(this.app, audioFile.path).then((audioBuffer) => {
      if (this.writing) {
        new Notice('Generator is already in progress.');
        return;
      }
      this.writing = true;
      new Notice('Generating transcript...');
      const fileType = audioFile.extension;
      this.generateTranscript(audioBuffer, fileType)
        .then((result) => {
          this.transcript = result;
          const prompt = this.settings.prompt + result;
          new Notice('Transcript generated...');
          this.generateText(prompt, editor, editor.getCursor('to').line);
          //if keepAudio is false and delete the audio file if so
          if (!this.settings.keepAudio) {
            this.app.vault.delete(audioFile); // Delete the audio file
          }
        })
        .catch((error) => {
          console.warn(error.message);
          new Notice(error.message);
          this.writing = false;
        });
    });
  }

  writeText(editor: Editor, LnToWrite: number, text: string) {
    const newLine = this.getNextNewLine(editor, LnToWrite);
    editor.setLine(newLine, '\n' + text.trim() + '\n');
    return newLine;
  }

  getNextNewLine(editor: Editor, Ln: number) {
    let newLine = Ln;
    while (editor.getLine(newLine).trim().length > 0) {
      if (newLine === editor.lastLine())
        editor.setLine(newLine, editor.getLine(newLine) + '\n');
      newLine++;
    }
    return newLine;
  }

  commandGenerateTranscript(editor: Editor) {
    const position = editor.getCursor();
    const text = editor.getRange({ line: 0, ch: 0 }, position);
    const regex = [
      /(?<=\[\[)(([^[\]])+)\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)(?=]])/g,
      /(?<=\[(.*)]\()(([^[\]])+)\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)(?=\))/g,
    ];
    this.findFilePath(text, regex)
      .then((path) => {
        const fileType = path.split('.').pop();
        if (fileType === undefined || fileType == null || fileType === '') {
          new Notice('No audio file found');
        } else {
          this.app.vault.adapter.exists(path).then((exists) => {
            if (!exists) throw new Error(path + ' does not exist');
            readBinaryFile(this.app, path).then((audioBuffer) => {
              if (this.writing) {
                new Notice('Generator is already in progress.');
                return;
              }
              this.writing = true;
              new Notice('Generating transcript...');
              this.generateTranscript(audioBuffer, fileType)
                .then((result) => {
                  this.transcript = result;
                  const prompt = this.settings.prompt + result;
                  new Notice('Transcript generated...');
                  this.generateText(
                    prompt,
                    editor,
                    editor.getCursor('to').line,
                  );
                })
                .catch((error) => {
                  console.warn(error.message);
                  new Notice(error.message);
                  this.writing = false;
                });
            });
          });
        }
      })
      .catch((error) => {
        console.warn(error.message);
        new Notice(error.message);
      });
  }

  async findFilePath(text: string, regex: RegExp[]) {
    console.log('dir text: ', text);

    let filename = '';
    let result: RegExpExecArray | null;

    // Extract the filename using the provided regex patterns
    for (const reg of regex) {
      while ((result = reg.exec(text)) !== null) {
        filename = normalizePath(decodeURI(result[0])).trim();
      }
    }

    if (filename === '') throw new Error('No file found in the text.');

    console.log('file name: ', filename);

    // Use the filename directly as the full path
    const fullPath = filename;

    console.log('full path: ', fullPath);

    // Check if the file exists at the constructed path
    const fileExists =
      this.app.vault.getAbstractFileByPath(fullPath) instanceof TAbstractFile;
    if (fileExists) return fullPath;

    // If not found, search through all files in the vault
    const allFiles = this.app.vault.getFiles();
    const foundFile = allFiles.find(
      (file) => file.name === filename.split('/').pop(),
    );
    if (foundFile) return foundFile.path;

    throw new Error('File not found');
  }

  async generateTranscript(
    audioBuffer: ArrayBuffer,
    filetype: string,
  ): Promise<string> {
    if (this.settings.apiKey.length <= 1)
      throw new Error('OpenAI API Key is not provided.');

    try {
      // Step 1: Decode Audio Data
      const decodedAudioData =
        await this.audioContext.decodeAudioData(audioBuffer);

      // Optional: Downsample the audio to 16 kHz for Whisper
      const targetSampleRate = 16000;
      const downsampledAudioBuffer = await this.downsampleAudioBuffer(
        decodedAudioData,
        targetSampleRate,
      );

      // Step 2: Split Audio Buffer into chunks less than 25 MB
      const chunkDuration = 600; // in seconds (10 minutes)
      const audioChunks = this.splitAudioBuffer(
        downsampledAudioBuffer,
        chunkDuration,
      );

      const results: string[] = [];

      for (let i = 0; i < audioChunks.length; i++) {
        new Notice(`Transcribing chunk #${i + 1} of ${audioChunks.length}...`);

        // Step 3: Encode Chunk to WAV
        const wavArrayBuffer = this.encodeAudioBufferToWav(audioChunks[i]);

        // Check the size of the encoded WAV file
        const sizeInMB = wavArrayBuffer.byteLength / (1024 * 1024);
        if (sizeInMB > 24) {
          throw new Error('Chunk size exceeds 25 MB limit.');
        }

        // Step 4: Send Chunk to Whisper API
        const formData = new FormData();
        const blob = new Blob([wavArrayBuffer], { type: 'audio/wav' });
        formData.append('file', blob, 'audio.wav');
        formData.append('model', 'whisper-1');

        const response = await fetch(
          'https://api.openai.com/v1/audio/transcriptions',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + this.settings.apiKey,
            },
            body: formData,
          },
        );

        const result = await response.json();
        if (response.ok && result.text) {
          results.push(result.text);
        } else {
          throw new Error(`Error: ${result.error.message}`);
        }

        // Wait a bit between requests to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      return results.join(' ');
    } catch (error) {
      console.error('Transcription failed:', error);
      if (error.message.includes('401')) {
        throw new Error('OpenAI API Key is not valid.');
      } else if (error.message.includes('400')) {
        throw new Error('Bad Request. Please check the format of the request.');
      } else {
        throw error;
      }
    }
  }

  async downsampleAudioBuffer(
    audioBuffer: AudioBuffer,
    targetSampleRate: number,
  ): Promise<AudioBuffer> {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const duration = audioBuffer.duration;

    const offlineContext = new OfflineAudioContext(
      numberOfChannels,
      targetSampleRate * duration,
      targetSampleRate,
    );

    // Create buffer source
    const bufferSource = offlineContext.createBufferSource();
    bufferSource.buffer = audioBuffer;

    // Connect the buffer source to the offline context destination
    bufferSource.connect(offlineContext.destination);

    // Start rendering
    bufferSource.start(0);
    const renderedBuffer = await offlineContext.startRendering();

    return renderedBuffer;
  }

  splitAudioBuffer(
    audioBuffer: AudioBuffer,
    chunkDuration: number,
  ): AudioBuffer[] {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const totalSamples = audioBuffer.length;

    const chunks: AudioBuffer[] = [];
    let offset = 0;
    const samplesPerChunk = Math.floor(chunkDuration * sampleRate);

    while (offset < totalSamples) {
      const chunkSamples = Math.min(samplesPerChunk, totalSamples - offset);
      const chunkBuffer = new AudioBuffer({
        length: chunkSamples,
        numberOfChannels: numberOfChannels,
        sampleRate: sampleRate,
      });

      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = audioBuffer
          .getChannelData(channel)
          .subarray(offset, offset + chunkSamples);
        chunkBuffer.copyToChannel(channelData, channel, 0);
      }

      chunks.push(chunkBuffer);
      offset += chunkSamples;
    }

    return chunks;
  }

  encodeAudioBufferToWav(audioBuffer: AudioBuffer): ArrayBuffer {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    const numSamples = audioBuffer.length * numChannels;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    /* RIFF identifier */
    this.writeString(view, 0, 'RIFF');
    /* file length */
    view.setUint32(4, 36 + numSamples * 2, true);
    /* RIFF type */
    this.writeString(view, 8, 'WAVE');
    /* format chunk identifier */
    this.writeString(view, 12, 'fmt ');
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (raw) */
    view.setUint16(20, format, true);
    /* channel count */
    view.setUint16(22, numChannels, true);
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */
    view.setUint32(28, (sampleRate * numChannels * bitDepth) / 8, true);
    /* block align (channel count * bytes per sample) */
    view.setUint16(32, (numChannels * bitDepth) / 8, true);
    /* bits per sample */
    view.setUint16(34, bitDepth, true);
    /* data chunk identifier */
    this.writeString(view, 36, 'data');
    /* data chunk length */
    view.setUint32(40, numSamples * 2, true);

    // Write interleaved data
    let offset = 44;
    for (let i = 0; i < audioBuffer.length; i++) {
      for (let channel = 0; channel < numChannels; channel++) {
        let sample = audioBuffer.getChannelData(channel)[i];
        // Clip sample
        sample = Math.max(-1, Math.min(1, sample));
        // Scale to 16-bit integer
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }

    return buffer;
  }

  writeString(view: DataView, offset: number, string: string): void {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  async generateText(
    prompt: string,
    editor: Editor,
    currentLn: number,
    contextPrompt?: string,
  ) {
    if (prompt.length < 1) throw new Error('Cannot find prompt.');
    if (this.settings.apiKey.length <= 1)
      throw new Error('OpenAI API Key is not provided.');

    prompt = prompt + '.';

    const newPrompt = prompt;

    const messages = [];

    messages.push({
      role: 'user',
      content: newPrompt,
    });

    new Notice('Performing customized superhuman analysis...');

    let LnToWrite = this.getNextNewLine(editor, currentLn);
    const lastLine = LnToWrite;
    const mock_env = {
      chunk_handler: (chunk: string) => {
        editor.setLine(LnToWrite, editor.getLine(LnToWrite) + chunk);
        if (chunk.includes('\n')) {
          LnToWrite = this.getNextNewLine(editor, LnToWrite);
        }
      },
      done_handler: (final_resp: string) => {
        LnToWrite = this.getNextNewLine(editor, lastLine);
        if (this.settings.includeTranscript) {
          editor.setLine(
            LnToWrite,
            editor.getLine(LnToWrite) + '\n# Transcript\n' + this.transcript,
          );
        }
      },
    };

    const smart_chat_model = new SmartChatModel(mock_env, 'openai', {
      api_key: this.settings.apiKey,
      model: this.settings.model,
    });
    const resp = await smart_chat_model.complete({ messages: messages });

    this.writing = false;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SmartMemosSettingTab extends PluginSettingTab {
  plugin: SmartMemosPlugin;

  constructor(app: App, plugin: SmartMemosPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('OpenAI api key')
      .setDesc('Ex: sk-as123mkqwenjasdasdj12...')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.apiKey)
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            // console.log('API Key: ' + value);
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Select the model to use for note-generation')
      .addDropdown((dropdown) => {
        dropdown.addOptions(
          MODELS.reduce((models: { [key: string]: string }, model) => {
            models[model] = model;
            return models;
          }, {}),
        );
        dropdown.setValue(this.plugin.settings.model);
        dropdown.onChange(async (value) => {
          // console.log('Model: ' + value);
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Custom transcription-to-notes prompt')
      .setDesc(
        'Prompt that will be sent to Chatpgt right before adding your transcribed audio',
      )
      .addTextArea((text) => {
        if (text.inputEl) {
          text.inputEl.classList.add('smart-memo-text-box');
        }
        text
          .setPlaceholder(
            'Act as my personal secretary and worlds greatest entreprenuer and know I will put these notes in my personal obsidian where I have all my notes linked by categories, tags, etc. The following is a transcription of recording of someone talking aloud or people in a conversation. May be a lot of random things that are said given fluidity of conversation and the microphone ability to pick up all audio. Make outline of all topics and points within a structured hierarchy. Make sure to include any quantifiable information said such as the cost of headphones being $400.  Then go into to detail with summaries that explain things more eloquently. Finally, Create a mermaid chart code that complements the outline.\n\n',
          )
          .setValue(this.plugin.settings.prompt)
          .onChange(async (value) => {
            this.plugin.settings.prompt = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Include Transcript')
      .setDesc(
        'Toggle this setting if you want to include the raw transcript on top of custom notes.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeTranscript)
          .onChange(async (value) => {
            this.plugin.settings.includeTranscript = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Recording File Path')
      .setDesc(
        'Specify the file path where recordings will be saved. Ex. If you want to put recordings in Resources folder then path is "Resources" (Defaults to root)',
      )
      .addText((text) =>
        text
          .setPlaceholder('Ex. Resources (if in Resources)')
          .setValue(this.plugin.settings.recordingFilePath || '')
          .onChange(async (value) => {
            this.plugin.settings.recordingFilePath = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Save Audio File')
      .setDesc(
        'Toggle this setting if you want to save/remove the audio file after it has been transcribed.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.keepAudio)
          .onChange(async (value) => {
            this.plugin.settings.keepAudio = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Include Audio Player')
      .setDesc(
        'Toggle this setting if you want the audio file player to be displayed along with the transcription.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeAudioFileLink)
          .onChange(async (value) => {
            this.plugin.settings.includeAudioFileLink = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
