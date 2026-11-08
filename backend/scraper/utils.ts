import { uuidv5 } from '../lib/uuid-v5.ts';

/** name -> UUID v5, in the app-wide label namespace below. */
const nameToUUID = (name: string): string => {
  const namespace =  '699d9c07-b965-4399-bafd-18a3cacf073c';
  return uuidv5(name, namespace);
};

/**
 * 判断一个字符串中是否包含字母
 * @param {String} str
 */
const hasLetter = (str: string): boolean => {
  // TypeScript rejects `for...in` over a string; iterating its indices visits
  // the same sequence of code units that the old loop did.
  for (let i = 0; i < str.length; i++) {
    let asc = str.charCodeAt(i);
    if ((asc >= 65 && asc <= 90 || asc >= 97 && asc <= 122)) {
      return true;
    }
  }
  return false;
};

export { nameToUUID, hasLetter };
