# 第一批 P0 修复 — 远程验收原始证据（106.37.96.58:6422）

> 采集时间：2026-08-12（北京时间）。以下均为 ssh 执行的真实命令与原始输出，契约④⑤⑥ 对应。
> 契约①②③⑦ 的本地证据（typecheck/test/smoke/git diff）由 auditor 独立复跑验证。

########## 契约⑥a: 设置页模型读回 (GET /api/models/active) ##########
$ curl -s http://localhost:8080/api/models/active
{"providerId":"bf5b213b-fb5b-45eb-bb13-3b2290744f04","modelId":"deepseek-v4-flash"}
########## 契约⑥d: 核心流程 (建库→导入→练习→判分→错题本) ##########
$ 建库
bankId=3f76fea5-69f6-4435-a0c7-31804ce3d59e
$ 导入2题
{"bankId":"3f76fea5-69f6-4435-a0c7-31804ce3d59e","count":2}
$ 起练习
{"id":"54ae3f67-de4a-46ef-862a-1f725cc86164","bankId":"3f76fea5-69f6-4435-a0c7-31804ce3d59e","questionIds":["14b499cd-e5ce-4465-b888-9cd2d5e067b1","c89b5446-d03b-40d3-86f8-479ba897a5e2"],"currentIndex":0,"scope":{"bankId":"3f76fea5-69f6-4435-a0c7-31804ce3d59e","mode":"all"},"createdAt":1786505136094}
$ 答2题 (grade)
{"attemptId":"b78cd553-3e54-4ad5-b455-64fd31035cd2","isCorrect":true,"correctAnswer":1}
{"attemptId":"740d97b0-b399-4cd3-bba1-9ab081587715","isCorrect":false,"correctAnswer":true}
########## 契约④: 练习判分态 (GET /api/practice/:id/graded) ##########
$ curl -s <http://localhost:8080/api/practice/54ae3f67-de4a-46ef-862a-1f725cc86164/graded>
{"14b499cd-e5ce-4465-b888-9cd2d5e067b1":{"attemptId":"b78cd553-3e54-4ad5-b455-64fd31035cd2","isCorrect":true,"correctAnswer":1,"answeredAt":1786505136259},"c89b5446-d03b-40d3-86f8-479ba897a5e2":{"attemptId":"740d97b0-b399-4cd3-bba1-9ab081587715","isCorrect":false,"correctAnswer":true,"answeredAt":1786505136277}}
########## 契约⑥d: 错题本 ##########
$ curl -s 'http://localhost:8080/api/quiz/wrong?bankId=3f76fea5-69f6-4435-a0c7-31804ce3d59e'
[{"question":{"id":"c89b5446-d03b-40d3-86f8-479ba897a5e2","bankId":"3f76fea5-69f6-4435-a0c7-31804ce3d59e","type":"boolean","stem":"验收题2: 地球是圆的","options":[],"answer":true,"explanation":"","tags":["验收"],"source":"file","createdAt":1786505136077},"wrongCount":1,"lastWrongAt":1786505136277,"mastered":false}]
########## 契约⑥b: SSE 讲解流式 ##########
$ curl -s -N -m 30 -X POST /api/tutor/explain (统计帧) attemptId=8f72d50e-c69d-40f8-b95d-aa349c0a1193
delta帧数: 432
done帧数: 1
error帧数: 0
内容开头: event: delta data: {"text":"##"}  event: delta data: {"text":" "}  event: delta data: {"text":"讲解"}  event: delta da

########## 契约⑤: 答疑历史过滤 (GET /api/tutor/history) ##########
$ curl -s '<http://localhost:8080/api/tutor/history?questionId=14b499cd-e5ce-4465-b888-9cd2d5e067b1>'
返回轮数: 1
[assistant] ## 讲解  **正确答案是：选项 1（2），你选择了选项 0（1），答错了。**  ---  ### 为什么正确答案是
首条是user吗(应False): False
首条含系统提示词(你是/讲题老师,应False): False

########## 契约⑥c: 断连/杀进程后客户端不挂死 ##########
$ 1) 发起长讲解流 (后台)
questionId=14b499cd-e5ce-4465-b888-9cd2d5e067b1 attemptId=2c6bf742-21d8-4914-be51-9cf335a66844
$ 2) 流进行中 3 秒后 kill api 容器
b1dc1c986982
docker kill 返回: 0
$ 3) 客户端 curl 结果 (退出码0=正常关闭不挂死)
curl退出码: 0
$ 4) 恢复容器
api状态: Up 25 seconds (healthy)
$ 5) 恢复后数据与接口完好
{"ok":true,"dataDir":"/app/data"}
题库数: 2
