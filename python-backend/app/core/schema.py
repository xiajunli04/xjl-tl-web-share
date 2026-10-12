from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """接口模型：JSON 字段为 camelCase，Python 侧为 snake_case。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, protected_namespaces=())
