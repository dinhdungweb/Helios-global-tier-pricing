'use strict';

const TIER_SETTING_PREFIX = 'tier_';

function mergePublishedThemeSettings(settingsDataContent, settingsSchemaContent) {
  const settingsData = parseThemeJson(
    settingsDataContent,
    'config/settings_data.json'
  );
  const settingsSchema = parseThemeJson(
    settingsSchemaContent,
    'config/settings_schema.json'
  );

  if (!Array.isArray(settingsSchema)) {
    throw new Error('config/settings_schema.json must contain an array');
  }
  if (
    !settingsData.current ||
    typeof settingsData.current !== 'object' ||
    Array.isArray(settingsData.current)
  ) {
    throw new Error('config/settings_data.json is missing current settings');
  }

  const defaults = {};
  for (const group of settingsSchema) {
    if (!group || !Array.isArray(group.settings)) {
      continue;
    }
    for (const setting of group.settings) {
      if (
        setting &&
        typeof setting.id === 'string' &&
        setting.id.startsWith(TIER_SETTING_PREFIX) &&
        Object.prototype.hasOwnProperty.call(setting, 'default')
      ) {
        defaults[setting.id] = setting.default;
      }
    }
  }

  const currentTierSettings = Object.entries(settingsData.current)
    .filter(([key]) => key.startsWith(TIER_SETTING_PREFIX))
    .reduce((result, [key, value]) => {
      result[key] = value;
      return result;
    }, {});

  return {
    ...defaults,
    ...currentTierSettings
  };
}

function parseThemeJson(content, filename) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`${filename} is empty`);
  }

  try {
    return JSON.parse(normalizeShopifyJson(content));
  } catch (error) {
    throw new Error(`${filename} contains invalid JSON: ${error.message}`);
  }
}

function normalizeShopifyJson(content) {
  const withoutComments = stripJsonComments(String(content).replace(/^\uFEFF/, ''));
  return stripTrailingCommas(withoutComments);
}

function stripJsonComments(content) {
  let result = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];

    if (inLineComment) {
      if (character === '\n' || character === '\r') {
        inLineComment = false;
        result += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false;
        index += 1;
      } else if (character === '\n' || character === '\r') {
        result += character;
      }
      continue;
    }
    if (!inString && character === '/' && nextCharacter === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (!inString && character === '/' && nextCharacter === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += character;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
    }
  }

  return result;
}

function stripTrailingCommas(content) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (lookahead < content.length && /\s/.test(content[lookahead])) {
        lookahead += 1;
      }
      if (content[lookahead] === ']' || content[lookahead] === '}') {
        continue;
      }
    }
    result += character;
  }

  return result;
}

module.exports = {
  mergePublishedThemeSettings,
  parseThemeJson
};
