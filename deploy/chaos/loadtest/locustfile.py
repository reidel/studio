#!/usr/bin/env python
import json
import os
import time
from random import choice

from locust import HttpLocust
from locust import task
from locust import TaskSet
try:
    import urllib.request as urlrequest
except ImportError:
    import urllib as urlrequest

USERNAME = os.getenv("LOCUST_USERNAME") or "a@a.com"
PASSWORD = os.getenv("LOCUST_PASSWORD") or "a"


class BaseTaskSet(TaskSet):
    max_wait = 60000

    def _login(self):
        """
        Helper function to log in the user to the current session.
        """
        resp = self.client.get("/accounts/login/")
        csrf = resp.cookies["csrftoken"]

        formdata = {
            "username": USERNAME,
            "password": PASSWORD,
            "csrfmiddlewaretoken": csrf,
        }
        self.client.post(
            "/accounts/login/",
            data=formdata,
            headers={
                "content-type": "application/x-www-form-urlencoded",
                "referer": "{}/accounts/login/".format(self.client.base_url)
            }
        )

    def _run_async_task(self, url, channel_id, data):
        copy_resp = self.client.post(url,
                                     data=json.dumps(data),
                                     headers={
                                         "content-type": "application/json",
                                         'X-CSRFToken': self.client.cookies.get('csrftoken'),
                                         'Referer': self.client.base_url
                                     })
        copy_resp_data = copy_resp.json()
        task_id = copy_resp_data["id"]
        finished = False
        time_elapsed = 0
        status = 'QUEUED'
        while not finished:
            time.sleep(1)
            time_elapsed += 1
            task_resp = self.client.get("/api/task/{}?channel_id={}".format(task_id, channel_id))
            task_data = task_resp.json()
            if task_data["status"] in ["SUCCESS", "FAILED"] or time_elapsed > 120:
                finished = True
                status = task_data["status"]

        return status


class ChannelListPage(BaseTaskSet):
    """
    Task to explore different channels lists
    """
    def on_start(self):
        self._login()

    def channel_list_api_calls(self):
        self.client.get("/get_user_pending_channels/")
        self.client.get("/get_user_edit_channels/")
        self.client.get("/get_user_bookmarked_channels/")
        self.client.get("/get_user_public_channels/")
        self.client.get("/get_user_view_channels/")

    @task
    def channel_list(self):
        """
        Load the channel page and the important endpoints.
        """
        self.client.get("/channels/")
        self.channel_list_api_calls()


class ChannelPage(BaseTaskSet):
    """
    Task to open and view a channel, including its topics and nodes
    """
    def on_start(self):
        self._login()

    def get_first_public_channel_id(self):
        """
        Returns the id of the first available public channel
        :returns: id of the first available public channel or None if there are not public channels
        """
        resp = self.client.get("/get_user_public_channels/").json()
        try:
            channel_id = resp[0]['id']
        except IndexError:
            channel_id = None
        return channel_id

    def get_first_edit_channel_id(self):
        """
        Returns the id of the first available public channel
        :returns: id of the first available public channel or None if there are not public channels
        """
        resp = self.client.get("/get_user_edit_channels/").json()
        try:
            channel_id = resp[0]['id']
        except IndexError:
            channel_id = None
        return channel_id

    def get_topic_id(self, channel_id, random=False):
        """
        Returns the id of a randomly selected topic for the provided channel_id
        :param: channel_id: id of the channel where the topic must be found
        :returns: id of the selected topic
        """
        channel_resp = self.client.get('/api/channel/{}'.format(channel_id)).json()
        children = channel_resp['main_tree']['children']
        topic_id = children[0]
        if random:
            topic_id = choice(children)
        return topic_id

    def get_resource_id(self, topic_id, random=False):
        """
        Returns the id of a randoly selected resource for the provided topic_id
        :param: topic_id: id of the topic where the resource must be found
        :returns: id of the selected resource
        """
        nodes_resp = self.client.get('/api/get_nodes_by_ids/{}'.format(topic_id)).json()
        try:
            while nodes_resp[0]['kind'] == 'topic':
                nodes = nodes_resp[0]['children']
                nodes_resp = self.client.get('/api/get_nodes_by_ids/{}'.format(','.join(nodes))).json()
            node_id = nodes_resp[0]['id']
            if random:
                node_id = choice(nodes_resp)['id']
            return node_id
        except IndexError:
            return None

    @task
    def open_channel(self, channel_id=None):
        """
        Open to edit a channel, if channel_id is None it opens the first public channel
        """
        if not channel_id:
            channel_id = self.get_first_public_channel_id()
        if channel_id:
            self.client.get('/channels/{}'.format(channel_id))

    # This is hit hard during heavy usage, and is one of our slowest calls,
    # so give it some extra weight.
    @task(3)
    def open_accessible_channels(self, channel_id=None):
        """
        Open to edit a channel, if channel_id is None it opens the first public channel
        """
        if not channel_id:
            channel_id = self.get_first_edit_channel_id()
        if channel_id:
            self.client.get('/accessible_channels/{}'.format(channel_id))

    # This is the most frequently hit scenario outside of ricecooker usage, so give it more weight.
    @task(3)
    def open_subtopic(self, channel_id=None, topic_id=None):
        """
        Open  a topic, if channel_id is None it opens the first public channel
        """
        if not channel_id:
            channel_id = self.get_first_public_channel_id()
        if channel_id and not topic_id:
            topic_id = self.get_topic_id(channel_id)
        if topic_id:
            self.get_resource_id(topic_id)

    @task
    def preview_content_item(self, content_id=None, random=False):
        """
        Do request on all the files for a content item.
        If content_id is not provided it will fetch a random content
        """
        if not content_id:
            channel_id = self.get_first_public_channel_id()
            topic_id = self.get_topic_id(channel_id, random=random)
            content_id = self.get_resource_id(topic_id, random=random)
            if content_id:
                resp = self.client.get('/api/get_nodes_by_ids_complete/{}'.format(content_id)).json()
                if 'files' in resp[0]:
                    for resource in resp[0]['files']:
                        storage_url = resource['storage_url']
                        print("Requesting resource {}".format(storage_url))
                        urlrequest.urlopen(storage_url).read()


class ChannelEdit(BaseTaskSet):
    # This flag was recommended to ensure on_stop is always called, but it seems not to be enough
    # on its own to ensure this behavior. Leaving as it's possible this is needed, but along with
    # something else.
    always_run_on_stop = True

    def on_start(self):
        self._login()
        self.created_channels = []

    def on_stop(self):
        # FIXME: This is not being called when the run completes, need to find out why.
        # Note that until this is fixed, any channel with the name "Locust Test Channel"
        # in the database needs to be manually deleted.
        for channel in self.created_channels:
            self.client.delete(
                "/api/channel/{}/".format(channel),
                headers={
                    "content-type": "application/json",
                    'X-CSRFToken': self.client.cookies.get('csrftoken'),
                }
            )

            # TODO: check for deletion issues and report so that manual cleanup can be performed if needed.

    @task(6)
    def create_channel_and_copy_content(self):
        """
        Load the channel page and the important endpoints.
        """
        formdata = {
            "name": "Locust Test Channel",
            "description": "Description of locust test channel",
            "thumbnail_url": '/static/img/kolibri_placeholder.png',
            "count": 0,
            "size": 0,
            "published": False,
            "view_only": False,
            "viewers": [],
            "content_defaults": {},
            "pending_editors": []
        }
        resp = self.client.post(
            "/api/channel",
            data=json.dumps(formdata),
            headers={
                "content-type": "application/json",
                'X-CSRFToken': self.client.cookies.get('csrftoken'),
                'Referer': self.client.base_url
            }
        )

        data = resp.json()
        channel_id = data["id"]

        try:
            copy_data = {
                # KA Computing root node.
                "node_ids": ["76d5fd8636004b459a09aecbb2f8294e"],
                "sort_order": 1,
                "target_parent": data["main_tree"]["id"],
                "channel_id": channel_id
            }

            self._run_async_task('/api/duplicate_nodes/', channel_id, copy_data)

        finally:
            self.client.delete(
                "/api/channel/{}".format(channel_id),
                headers={
                    "content-type": "application/json",
                    'X-CSRFToken': self.client.cookies.get('csrftoken'),
                    'Referer': self.client.base_url
                }
            )


class LoginPage(BaseTaskSet):
    tasks = [ChannelListPage, ChannelPage, ChannelEdit]

    # This is by far our most hit endpoint, over 50% of all calls, so
    # weight it accordingly.
    @task(10)
    def loginpage(self):
        """
        Visit the login page and the i18n endpoints without logging in.
        """
        self.client.get("/accounts/login/")


class StudioDesktopBrowserUser(HttpLocust):
    task_set = LoginPage
    min_wait = 5000
    max_wait = 20000
