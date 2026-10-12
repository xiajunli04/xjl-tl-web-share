# Kubernetes Deployment Guide

Kubernetes is an open-source platform for automating the deployment, scaling and management of containerized applications. This guide walks you through deploying a stateless web application on a Kubernetes cluster, and explains the core concepts you will meet along the way.

## Core Concepts

A **Pod** is the smallest deployable unit in Kubernetes. Each Pod wraps one or more containers that share storage and network resources. Pods are ephemeral: when a node fails, the Pods running on it are lost, and a controller such as a Deployment creates replacement Pods on healthy nodes.

- A **Node** is a worker machine, either virtual or physical.
  - Every Node runs the `kubelet`, which talks to the control plane.
  - The container runtime on the Node pulls images and starts containers.
- A **Deployment** declares the desired state of your Pods.
- A **Service** exposes a set of Pods behind a stable network endpoint.

> Tip: keep your Pods stateless whenever possible. Stateless Pods can be rescheduled freely, which makes scaling and rolling updates much easier.

## Deploying the Application

First, make sure `kubectl` is configured to talk to your cluster. Run `kubectl get nodes` and check that every Node reports the status `Ready`. If you are new to the command line tool, see [the kubectl reference](https://kubernetes.io/docs/reference/kubectl/) for details.

Save the following manifest as `deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
```

Then apply it with `kubectl apply -f deployment.yaml`. The Deployment controller creates three Pods and keeps them running. If a Pod crashes, the controller replaces it automatically.

1. Check the rollout status with `kubectl rollout status deployment/web`.
2. List the Pods with `kubectl get pods -l app=web`.
3. Expose the Deployment through a Service of type `LoadBalancer`.

| Resource | Purpose | Scope |
| --- | --- | --- |
| Pod | Runs one or more containers | Namespace |
| Deployment | Manages replicated Pods | Namespace |
| Node | Provides compute capacity | Cluster |

<div class="note">The table above lists only the resources used in this guide.</div>

## Scaling and Updates

To handle more traffic, scale the Deployment to five replicas with `kubectl scale deployment/web --replicas=5`. Kubernetes schedules the new Pods on Nodes that have enough CPU and memory. Horizontal scaling works best when every Pod is identical and stateless.

When you release a new version, update the container image in the Deployment. Kubernetes performs a rolling update: it starts new Pods with the new image, waits until they are ready, and only then terminates the old Pods. If the new version fails its readiness checks, the rollout pauses, and you can roll back with `kubectl rollout undo deployment/web`.

---

This paragraph uses Windows line endings.
It spans two lines inside the same paragraph.

Hello {name}, your cluster has %d Nodes and the dashboard is available at https://dashboard.example.com.
