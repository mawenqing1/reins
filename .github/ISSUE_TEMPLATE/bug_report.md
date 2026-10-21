name: 缺陷报告
about: 报告一个可复现的问题
labels: bug
body:
  - type: textarea
    id: what-happened
    attributes:
      label: 发生了什么
      description: 附上复现步骤（操作序列越具体越好）
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: 期望行为
    validations:
      required: true
  - type: textarea
    id: env
    attributes:
      label: 环境
      description: 系统版本 / 应用获取方式（源码 npm start 或安装包）/ 相关 Agent 类型（API / CLI / 演示）
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: 控制台输出与数据自检
      description: 开发者工具控制台输出（源码运行：菜单 帮助 → 开发者工具）；若涉及数据异常，附「设置 → 数据自检」结果。密钥与令牌请打码
