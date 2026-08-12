import { useState } from 'react';

// 第三批 卫生⑧：flash 通知（BanksPage×2 / ImportPanel 原 3 份拷贝合一）
export function useFlashNotice() {
  const [notice, setNotice] = useState('');
  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };
  return { notice, flash };
}
