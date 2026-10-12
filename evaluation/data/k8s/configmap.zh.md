# ConfigMap

ConfigMap 并不提供保密或者加密功能。
如果你想存储的数据是机密的，请使用 Secret，
或者使用其他第三方工具来保证你的数据的私密性，而不是用 ConfigMap。

## 动机

使用 ConfigMap 来将你的配置数据和应用程序代码分开。

比如，假设你正在开发一个应用，它可以在你自己的电脑上（用于开发）和在云上（用于实际流量）运行。
你的代码里有一段是用于查看环境变量 `DATABASE_HOST`，在本地运行时，
你将这个变量设置为 `localhost`，在云上，你将其设置为引用 Kubernetes
集群中的公开数据库组件的 服务。

这让你可以获取在云中运行的容器镜像，并且如果有需要的话，在本地调试完全相同的代码。

ConfigMap 在设计上不是用来保存大量数据的。在 ConfigMap 中保存的数据不可超过
1 MiB。如果你需要保存超出此尺寸限制的数据，你可能希望考虑挂载存储卷或者使用独立的数据库或者文件服务。

## ConfigMap 对象

ConfigMap 是一个让你可以存储其他对象所需要使用的配置的 API 对象。
和其他 Kubernetes 对象都有一个 `spec` 不同的是，ConfigMap 使用 `data` 和
`binaryData` 字段。这些字段能够接收键-值对作为其取值。`data` 和 `binaryData`
字段都是可选的。`data` 字段设计用来保存 UTF-8 字符串，而 `binaryData`
则被设计用来保存二进制数据作为 base64 编码的字串。

ConfigMap 的名字必须是一个合法的
[DNS 子域名](/zh-cn/docs/concepts/overview/working-with-objects/names#dns-subdomain-names)。

`data` 或 `binaryData` 字段下面的每个键的名称都必须由字母数字字符或者
`-`、`_` 或 `.` 组成。在 `data` 下保存的键名不可以与在 `binaryData`
下出现的键名有重叠。

从 v1.19 开始，你可以添加一个 `immutable` 字段到 ConfigMap 定义中，
创建[不可变更的 ConfigMap](#configmap-immutable)。

## ConfigMap 和 Pod

你可以写一个引用 ConfigMap 的 Pod 的 `spec`，并根据 ConfigMap 中的数据在该
Pod 中配置容器。这个 Pod 和 ConfigMap
必须要在同一个名字空间中。

静态 Pod 中的 `spec`
字段不能引用 ConfigMap 或任何其他 API 对象。

这是一个 ConfigMap 的示例，它的一些键只有一个值，其他键的值看起来像是配置的片段格式。

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: game-demo
data:
  # 类属性键；每一个键都映射到一个简单的值
  player_initial_lives: "3"
  ui_properties_file_name: "user-interface.properties"

  # 类文件键
  game.properties: |
    enemy.types=aliens,monsters
    player.maximum-lives=5
  user-interface.properties: |
    color.good=purple
    color.bad=yellow
    allow.textmode=true
```

你可以使用四种方式来使用 ConfigMap 配置 Pod 中的容器：

1. 在容器命令和参数内
1. 容器的环境变量
1. 在只读卷里面添加一个文件，让应用来读取
1. 编写代码在 Pod 中运行，使用 Kubernetes API 来读取 ConfigMap

这些不同的方法适用于不同的数据使用方式。
对前三个方法，kubelet
使用 ConfigMap 中的数据在 Pod 中启动容器。

第四种方法意味着你必须编写代码才能读取 ConfigMap 和它的数据。然而，
由于你是直接使用 Kubernetes API，因此只要 ConfigMap 发生更改，
你的应用就能够通过订阅来获取更新，并且在这样的情况发生的时候做出反应。
通过直接进入 Kubernetes API，这个技术也可以让你能够获取到不同的名字空间里的 ConfigMap。

下面是一个 Pod 的示例，它通过使用 `game-demo` 中的值来配置一个 Pod：

ConfigMap 不会区分单行属性值和多行类似文件的值，重要的是 Pod
和其他对象如何使用这些值。

上面的例子定义了一个卷并将它作为 `/config` 文件夹挂载到 `demo` 容器内，
创建两个文件，`/config/game.properties` 和 `/config/user-interface.properties`，
尽管 ConfigMap 中包含了四个键。这是因为 Pod 定义中在 `volumes` 节指定了一个 `items` 数组。
如果你完全忽略 `items` 数组，则 ConfigMap 中的每个键都会变成一个与该键同名的文件，
因此你会得到四个文件。
