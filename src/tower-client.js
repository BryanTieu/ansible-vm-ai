import axios from "axios";
import http from "http";
import https from "https";

export class TowerClient {
  constructor(config) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.tower.url.replace(/\/$/, ""),
      auth: {
        username: config.tower.username,
        password: config.tower.password,
      },
      httpAgent: new http.Agent(),
      httpsAgent: new https.Agent({ rejectUnauthorized: config.tower.verify_ssl }),
      validateStatus: () => true,
    });
  }

  async getTemplateByName(name) {
    const response = await this.client.get("/api/v2/job_templates/", {
      params: { search: name },
    });

    if (response.status !== 200) {
      throw new Error(`Tower API error while searching templates: ${response.status}`);
    }

    const template = (response.data.results || []).find(
      (item) => item.name.toLowerCase() === name.toLowerCase()
    );

    if (!template) {
      throw new Error(`Template not found: ${name}`);
    }

    return template;
  }

  async launchTemplateByName(name, extraVars = {}) {
    const template = await this.getTemplateByName(name);
    const response = await this.client.post(`/api/v2/job_templates/${template.id}/launch/`, {
      extra_vars: JSON.stringify(extraVars),
    });

    if (response.status !== 201) {
      throw new Error(`Launch failed: ${response.status} ${JSON.stringify(response.data)}`);
    }

    return response.data;
  }

  async getJob(jobId) {
    const response = await this.client.get(`/api/v2/jobs/${jobId}/`);

    if (response.status !== 200) {
      throw new Error(`Failed to fetch job ${jobId}: ${response.status}`);
    }

    return response.data;
  }

  async getJobLogs(jobId) {
    const response = await this.client.get(`/api/v2/jobs/${jobId}/stdout/`, {
      params: { format: "txt" },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch logs for job ${jobId}: ${response.status}`);
    }

    return response.data;
  }
}
