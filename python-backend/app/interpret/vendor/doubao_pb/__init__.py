"""豆包同声传译 2.0（AST）官方 protobuf 定义生成的 Python 类（design D6，tasks 12.3）。

来源（2026-10-04 下载）：火山引擎文档《同声传译2.0-API接入文档》https://www.volcengine.com/docs/6561/1756902
"Protobuf" 一节的附件 protos.tar.gz（2026-09-02 版，含 TranslateResponse.detected_language 等新字段）。
protos/ 下为原样保存的 .proto 与官方 HOWTO.md；Python 类按官方 Demo（ast_python_client.zip）中 build_python.sh 的方式生成，
只保留 *_pb2.py（不需要 gRPC 桩），并把顶层包导入改为 app.interpret.vendor.doubao_pb 前缀：

    cd app/interpret/vendor/doubao_pb/protos
    uvx --from grpcio-tools python -m grpc_tools.protoc --proto_path=. --python_out=.. \
        common/events.proto common/rpcmeta.proto \
        products/understanding/base/au_base.proto products/understanding/ast/ast_service.proto
    # 然后把 ast_service_pb2.py 中的 `from common ...` / `from products...` 改为本包前缀

生成代码要求 protobuf 运行时 >= 7.35.1（gencode 版本）。本目录不参与 ruff 检查。
"""
