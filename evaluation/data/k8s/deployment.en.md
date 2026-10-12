# Deployments

A _Deployment_ provides declarative updates for Pods and
ReplicaSets.

You describe a _desired state_ in a Deployment, and the Deployment controller changes the actual state to the desired state at a controlled rate. You can define Deployments to create new ReplicaSets, or to remove existing Deployments and adopt all their resources with new Deployments.

Do not manage ReplicaSets owned by a Deployment. Consider opening an issue in the main Kubernetes repository if your use case is not covered below.

## Use Case

The following are typical use cases for Deployments:

* [Create a Deployment to rollout a ReplicaSet](#creating-a-deployment). The ReplicaSet creates Pods in the background. Check the status of the rollout to see if it succeeds or not.
* [Declare the new state of the Pods](#updating-a-deployment) by updating the PodTemplateSpec of the Deployment. A new ReplicaSet is created, and the Deployment gradually scales it up while scaling down the old ReplicaSet, ensuring Pods are replaced at a controlled rate. Each new ReplicaSet updates the revision of the Deployment.
* [Rollback to an earlier Deployment revision](#rolling-back-a-deployment) if the current state of the Deployment is not stable. Each rollback updates the revision of the Deployment.
* [Scale up the Deployment to facilitate more load](#scaling-a-deployment).
* [Pause the rollout of a Deployment](#pausing-and-resuming-a-deployment) to apply multiple fixes to its PodTemplateSpec and then resume it to start a new rollout.
* [Use the status of the Deployment](#deployment-status) as an indicator that a rollout has stuck.
* [Clean up older ReplicaSets](#clean-up-policy) that you don't need anymore.

## Creating a Deployment

The following is an example of a Deployment. It creates a ReplicaSet to bring up three `nginx` Pods:

In this example:

* A Deployment named `nginx-deployment` is created, indicated by the
  `.metadata.name` field. This name will become the basis for the ReplicaSets
  and Pods which are created later. See [Writing a Deployment Spec](#writing-a-deployment-spec)
  for more details.
* The Deployment creates a ReplicaSet that creates three replicated Pods, indicated by the `.spec.replicas` field.
* The `.spec.selector` field defines how the created ReplicaSet finds which Pods to manage.
  In this case, you select a label that is defined in the Pod template (`app: nginx`).
  However, more sophisticated selection rules are possible,
  as long as the Pod template itself satisfies the rule.

  The `.spec.selector.matchLabels` field is a map of {key,value} pairs.
  A single {key,value} in the `matchLabels` map is equivalent to an element of `matchExpressions`,
  whose `key` field is "key", the `operator` is "In", and the `values` array contains only "value".
  All of the requirements, from both `matchLabels` and `matchExpressions`, must be satisfied in order to match.

* The `.spec.template` field contains the following sub-fields:
  * The Pods are labeled `app: nginx`using the `.metadata.labels` field.
  * The Pod template's specification, or `.spec` field, indicates that
    the Pods run one container, `nginx`, which runs the `nginx`
    [Docker Hub](https://hub.docker.com/) image at version 1.14.2.
  * Create one container and name it `nginx` using the `.spec.containers[0].name` field.

Before you begin, make sure your Kubernetes cluster is up and running.
Follow the steps given below to create the above Deployment:

1. Create the Deployment by running the following command:

   ```shell
   kubectl apply -f https://k8s.io/examples/controllers/nginx-deployment.yaml
   ```

2. Run `kubectl get deployments` to check if the Deployment was created.

   If the Deployment is still being created, the output is similar to the following:
   ```
   NAME               READY   UP-TO-DATE   AVAILABLE   AGE
   nginx-deployment   0/3     0            0           1s
   ```
   When you inspect the Deployments in your cluster, the following fields are displayed:
   * `NAME` lists the names of the Deployments in the namespace.
   * `READY` displays how many replicas of the application are available to your users. It follows the pattern ready/desired.
   * `UP-TO-DATE` displays the number of replicas that have been updated to achieve the desired state.
   * `AVAILABLE` displays how many replicas of the application are available to your users.
   * `AGE` displays the amount of time that the application has been running.

   Notice how the number of desired replicas is 3 according to `.spec.replicas` field.

3. To see the Deployment rollout status, run `kubectl rollout status deployment/nginx-deployment`.

   The output is similar to:
   ```
   Waiting for rollout to finish: 2 out of 3 new replicas have been updated...
   deployment "nginx-deployment" successfully rolled out
   ```

4. Run the `kubectl get deployments` again a few seconds later.
   The output is similar to this:
   ```
   NAME               READY   UP-TO-DATE   AVAILABLE   AGE
   nginx-deployment   3/3     3            3           18s
   ```
   Notice that the Deployment has created all three replicas, and all replicas are up-to-date (they contain the latest Pod template) and available.

5. To see the ReplicaSet (`rs`) created by the Deployment, run `kubectl get rs`. The output is similar to this:
   ```
   NAME                          DESIRED   CURRENT   READY   AGE
   nginx-deployment-75675f5897   3         3         3       18s
   ```
   ReplicaSet output shows the following fields:

   * `NAME` lists the names of the ReplicaSets in the namespace.
   * `DESIRED` displays the desired number of _replicas_ of the application, which you define when you create the Deployment. This is the _desired state_.
   * `CURRENT` displays how many replicas are currently running.
   * `READY` displays how many replicas of the application are available to your users.
   * `AGE` displays the amount of time that the application has been running.

   Notice that the name of the ReplicaSet is always formatted as
   `[DEPLOYMENT-NAME]-[HASH]`. This name will become the basis for the Pods
   which are created.

   The `HASH` string is the same as the `pod-template-hash` label on the ReplicaSet.

6. To see the labels automatically generated for each Pod, run `kubectl get pods --show-labels`.
   The output is similar to:
   ```
   NAME                                READY     STATUS    RESTARTS   AGE       LABELS
   nginx-deployment-75675f5897-7ci7o   1/1       Running   0          18s       app=nginx,pod-template-hash=75675f5897
   nginx-deployment-75675f5897-kzszj   1/1       Running   0          18s       app=nginx,pod-template-hash=75675f5897
   nginx-deployment-75675f5897-qqcnn   1/1       Running   0          18s       app=nginx,pod-template-hash=75675f5897
   ```
   The created ReplicaSet ensures that there are three `nginx` Pods.

You must specify an appropriate selector and Pod template labels in a Deployment
(in this case, `app: nginx`).

Do not overlap labels or selectors with other controllers (including other Deployments and StatefulSets). Kubernetes doesn't stop you from overlapping, and if multiple controllers have overlapping selectors those controllers might conflict and behave unexpectedly.

### Pod-template-hash label

Do not change this label.

The `pod-template-hash` label is added by the Deployment controller to every ReplicaSet that a Deployment creates or adopts.

This label ensures that child ReplicaSets of a Deployment do not overlap. It is generated by hashing the `PodTemplate` of the ReplicaSet and using the resulting hash as the label value that is added to the ReplicaSet selector, Pod template labels,
and in any existing Pods that the ReplicaSet might have.
