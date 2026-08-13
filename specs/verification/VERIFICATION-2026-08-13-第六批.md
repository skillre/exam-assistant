# 第六批（UI 视觉重做·浅色纸感）验证 — 2026-08-13

## 测试与静态检查

- `pnpm typecheck`：0 错误
- `pnpm test`：100 passed / 16 files（全绿不降）
- `pnpm --filter @exam/server smoke`：51 断言 ✅
- `git diff --stat`（相对第五批收尾 430c289）：仅 packages/client/src/styles.css（重写）+ HistoryPage.tsx / InsightsPage.tsx（className 微调，各 2-3 处字符串）+ 证据文档；无 package.json/lock/schema/API/部署文件
- className 双向断言（脚本）：45 个在用类全部有选择器（补 `.panel` 历史孤儿类定义后）；无缺失
- 组件 diff 仅 className 字符串（HistoryPage 3 处 btn→btn ghost、InsightsPage 2 处 btn→btn ghost），功能逻辑零改动

## 浏览器实测（kimi-webbridge + 本地映射 127.0.0.1:8080，远程部署后）

### 计算样式抽查（getComputedStyle）
| 项 | 实测 | 契约 |
|---|---|---|
| body 背景 | rgb(250,250,249)=#FAFAF9 + 顶部绿晕 radial-gradient | ✓ |
| 主按钮 | rgb(21,128,61)=#15803D、border-radius 999px | ✓ |
| .content max-width | 1100px | ✓ |
| topbar | 胶囊 999px、top 12px、白 85% 半透明 blur | ✓ |
| 历史页操作按钮 | background none（ghost 化，14 个主色按钮消除） | ✓ |
| 横向溢出 | false | ✓ |
| color-scheme | light（原生控件浅色） | ✓ |
| focus-visible | 全局绿环 2px + option tabIndex 保留（代码核查） | ✓ |

### 视觉复核（vision-scout / sensenova 六页截图）
- 6 页全部浅色、无深色残留、无样式丢失/错位/对比度问题
- 结论："比深色版更现代干净——圆角卡片+白卡阴影+统一绿主色+红功能语义，UI kit 感强"

### 回归交互实测（契约⑦ 11 条链路）
1. ✅ 切 tab 六页（hash 路由正常）
2. ✅ 选库（TOGAF）→ 开始练习 → 40 题导航渲染 → 点选选项 → 判分态（option.correct 高亮 + ✗ 错误徽章联动）
3. ✅ 错题本「标记已掌握」：btn→过滤移出列表；勾选「显示已掌握」后 4 条「取消掌握」全部 btn ghost（btn↔btn ghost 状态切换正确，评审 #2 链路⑥）
4. ✅ 设置页：模型下拉正常、测试连接/编辑按钮 ghost 化
5. ✅ 导出 CSV/历史重练/学情下钻：代码零改动（diff 确认），第四批功能不受影响
6. ✅ 键盘 focus-visible：代码核查（全局 :focus-visible 绿环 + QuestionCard tabIndex 保留）
7. ✅ 客观题判分/essay UI：判分态实测正常；essay 样式（.essay-input）在 CSS 中定义

### 测试数据还原
- 标记的掌握已全部还原；练习会话 +1（正常使用痕迹，保留）

## 截图证据
- /tmp/exam-ui-new/01~08.png（六页 + 练习中 + 判分后）——已随本批归档
