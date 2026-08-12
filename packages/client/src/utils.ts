import { useState } from 'react';

// 第三批 卫生⑧：flash 通知统一入口（BanksPage 两组件 + ImportPanel 共用，auditor 修正）
export function useFlashNotice() {
  const [notice, setNotice] = useState('');
  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };
  return { notice, flash };
}
