name: 功能建议
about: 提出一个新功能或改进
labels: enhancement
body:
  - type: textarea
    id: problem
    attributes:
      label: 想解决什么问题
      description: 先说场景与痛点，而不是方案
    validations:
      required: true
  - type: textarea
    id: idea
    attributes:
      label: 你的设想
      description: 期望的交互 / 行为；已尝试过的替代方案
