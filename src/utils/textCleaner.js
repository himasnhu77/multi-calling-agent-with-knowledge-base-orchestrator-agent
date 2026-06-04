class TextCleaner {
  static forSpeech(text) {
    return text
      .replace(/\*\*/g, "")
      .replace(/#{1,6}\s?/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`{1,3}[^`]*`{1,3}/g, "")
      .replace(/\n{2,}/g, " ")
      .replace(/\n/g, " ")
      .trim();
  }

  static truncate(text, maxChars = 550) {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars).trim() + " … Want more detail?";
  }
}

module.exports = TextCleaner;
