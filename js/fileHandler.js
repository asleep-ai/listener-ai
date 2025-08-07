// File handling utilities for drag-drop, clipboard paste, and file dialog

class FileHandler {
  constructor() {
    // Use Set for O(1) lookups instead of Array O(n)
    this.validTypes = new Set(['audio/mp3', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a']);
    this.validExtensions = new Set(['.mp3', '.m4a']);
    this.maxSize = 500 * 1024 * 1024; // 500MB
    this.chunkSize = 0x8000; // 32KB for base64 conversion
  }

  // Validate file before processing
  validateFile(file) {
    if (!file) {
      throw new Error('No file provided');
    }

    if (file.size > this.maxSize) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(2);
      throw new Error(`File too large: ${sizeMB}MB (maximum: 500MB)`);
    }

    if (file.size === 0) {
      throw new Error('File is empty');
    }

    if (!file.name) {
      throw new Error('Invalid file: no filename');
    }

    const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
    const hasValidType = file.type && this.validTypes.has(file.type);
    const hasValidExtension = fileExtension && this.validExtensions.has(fileExtension);

    if (!hasValidType && !hasValidExtension) {
      throw new Error('Please select an MP3 or M4A audio file');
    }

    return true;
  }

  // Process audio file based on available data
  async processAudioFile(file) {
    try {
      this.validateFile(file);

      let result;

      // Check if file.path exists (only from file dialog)
      if (file.path) {
        // File dialog provides path for efficient copying
        result = await window.electronAPI.copyAudioFile({
          sourcePath: file.path,
          name: file.name
        });
      } else {
        // Use base64 encoding (for drag-drop and clipboard paste)
        result = await this.transferViaBase64(file);
      }

      return result;
    } catch (error) {
      console.error('Error processing audio file:', error);
      throw error;
    }
  }

  // Transfer file via base64 encoding (optimized)
  async transferViaBase64(file) {
    // Read file as buffer
    const buffer = await file.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('Failed to read file contents');
    }

    // Try FileReader API first (more efficient for large files)
    try {
      const base64Data = await this.arrayBufferToBase64(buffer);
      return await window.electronAPI.saveAudioFileBase64({
        name: file.name,
        dataBase64: base64Data
      });
    } catch (error) {
      // Fallback to manual conversion
      const uint8Array = new Uint8Array(buffer);
      let binary = '';

      for (let i = 0; i < uint8Array.length; i += this.chunkSize) {
        const chunk = uint8Array.subarray(i, i + this.chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }

      const base64Data = btoa(binary);
      return await window.electronAPI.saveAudioFileBase64({
        name: file.name,
        dataBase64: base64Data
      });
    }
  }

  // Efficient ArrayBuffer to Base64 using FileReader
  async arrayBufferToBase64(buffer) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([buffer]);
      const reader = new FileReader();
      
      reader.onloadend = () => {
        // Extract base64 from data URL
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Open file dialog and process selected file
  async selectFileViaDialog() {
    const result = await window.electronAPI.selectAudioFile();
    
    if (result.success && result.filePath) {
      // Get file info from main process
      const fileInfo = await window.electronAPI.getFileInfo(result.filePath);
      
      if (fileInfo.success) {
        // Create a pseudo-file object with path for efficient copying
        const fileWithPath = {
          name: fileInfo.name,
          path: result.filePath,
          size: fileInfo.size,
          type: fileInfo.name.endsWith('.mp3') ? 'audio/mp3' : 'audio/m4a'
        };
        
        return await this.processAudioFile(fileWithPath);
      } else {
        throw new Error('Failed to get file info');
      }
    }
    
    return null;
  }

  // Extract title from filename (remove extension)
  extractTitle(filePath) {
    const fileName = typeof filePath === 'string' ? filePath.split(/[/\\]/).pop() : filePath.name;
    return fileName ? fileName.replace(/\.[^/.]+$/, '') : 'Untitled';
  }
}

// Export for use in renderer.js
window.fileHandler = new FileHandler();